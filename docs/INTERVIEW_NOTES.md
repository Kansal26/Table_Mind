# TableMind: Senior Engineering Interview Notes

These notes are prepared for technical interviews to articulate the architecture, trade-offs, edge-case handling, and hardening work done on TableMind.

---

## 1. Core Architecture Questions

### Q1: Why did you choose TanStack Start and Server Functions over a separate Express/NestJS backend?
**Answer:**
TanStack Start gives us end-to-end type safety without maintaining code generation steps. Server functions (`createServerFn`) act as typed RPC endpoints where input schemas (validated with Zod) and return types are shared automatically between server and client. It eliminates duplicate type declarations, keeps private keys strictly on the server, and allows us to compile the entire backend into high-performance serverless or edge workers (via Nitro) with zero cold-start overhead compared to heavier containerized backends.

### Q2: How does the application prevent double payment and race conditions during checkout?
**Answer:**
We handle this at three distinct levels:
1. **Server-Side Order Creation:** The client never computes the payment amount. The server recalculates the bill from database prices and creates the order on Razorpay with an authoritative amount in paise.
2. **Signature & Gateway Verification:** When the client submits the payment callback, the server verifies both the HMAC-SHA256 signature and calls the Razorpay API to confirm that the transaction was captured and matches the expected amount down to the rupee.
3. **Atomic State Transition in PostgreSQL:** The state update executes inside a database stored procedure (`complete_payment`). The procedure acquires a row-level lock (`SELECT ... FOR UPDATE`) on the order record and checks if the status is already `paid`. If two verification requests or webhooks arrive concurrently, the first one succeeds and returns `1`, while the second returns `0` without deducting points twice or emitting duplicate notifications.

### Q3: What happens if Groq or the LLM is down when a diner opens the recommendations or speaks an order?
**Answer:**
Both AI features are built with strict fallback boundaries:
- **Recommendations:** We wrap the Groq completion call in a `Promise.race` with a 3000ms timeout. If Groq is slow, unreachable, or returns an error, the system catches the failure and immediately falls back to a deterministic rule-based engine (past order frequency, item co-occurrence, and overall diner rating scores). Diners never see a broken screen or spinning loader.
- **Voice Ordering:** If Groq fails to parse the transcript into valid menu items, the server returns a structured clarification response (`"I couldn't match that with our menu. Could you please specify the dish name?"`), prompting the diner to rephrase or tap the menu manually.

### Q4: How is tenant isolation enforced in a multi-tenant restaurant system?
**Answer:**
Tenant isolation is enforced in depth:
1. **Diners:** Access is strictly bounded by the physical `qr_token` at the table. Diners cannot query other tables or restaurants because all diner operations resolve the table and restaurant ID through the active session on the server.
2. **Restaurant Owners:** Every administrative server function extracts the Supabase Auth JWT, validates the user, and queries the `restaurants` table matching `owner_id = user.id`. If a user attempts to edit a menu item, coupon, or table that belongs to another restaurant, the query returns no rows and the server throws an unauthorized error.
3. **Database RLS Policies:** Row Level Security policies on PostgreSQL enforce that public anonymous clients can only read published menu items and active restaurant metadata.

### Q5: Why are table QR codes Base64URL tokens instead of sequential numbers like `/table/5`?
**Answer:**
Using sequential table numbers allows enumeration attacks where anyone outside the restaurant can tamper with carts, call waiters, or order food to disrupt operations. We use high-entropy, cryptographically random Base64URL tokens. Diners can only interact with a table if they have scanned the physical code inside the restaurant. Owners can also regenerate the token in one click if a QR code is compromised.

### Q6: How would you scale TableMind to 1,000 active restaurants?
**Answer:**
1. **Database Connection Pooling:** Move to transaction-mode connection pooling (PgBouncer or Supabase Supavisor) to support thousands of concurrent client connections without exhausting PostgreSQL process limits.
2. **Read Replica for Public Catalogues:** Menu browsing and public restaurant branding represent 80%+ of read volume. Directing these reads to a read replica or caching them on a global CDN edge (Cloudflare KV or Fastly) with cache tags invalidated on menu edits would reduce database load by over 75%.
3. **Asynchronous Notification Queues:** Move email receipt dispatch and staff webhook alerts from direct execution into a durable message queue (like RabbitMQ, Amazon SQS, or Redis BullMQ) so external API latency never blocks HTTP response times.
4. **Partitioning:** Partition high-velocity tables (`order_items`, `orders`, `recommendation_logs`) by `restaurant_id` or date range (`created_at`) to keep index sizes small and queries fast.

### Q7: How does the coupon engine prevent exploitation, like applying an expired coupon across midnight?
**Answer:**
Coupons support time-of-day windows (e.g., late-night happy hour from 22:00 to 02:00). A standard `>= start_time AND <= end_time` check fails when a window wraps past midnight because 01:00 is less than 22:00. Our server engine detects overnight windows (`end_time < start_time`) and evaluates them as `current_time >= start_time OR current_time <= end_time`. Additionally, the engine validates minimum order spend, dish exclusions, and restricts first-order promotions to authenticated accounts with verified order history.

### Q8: Why use PostgreSQL for rate limiting instead of Redis?
**Answer:**
In our current architecture, maintaining a separate Redis cluster would introduce additional infrastructure cost, operational overhead, and potential network failure modes between services. By implementing sliding-window rate limiting using a lightweight PostgreSQL table with compound indexes and a cleanup stored procedure, we achieved strict rate limiting using existing database infrastructure. For higher scale (thousands of requests per second), migrating the rate limiter to Redis with an atomic Lua script is the natural next step.

### Q9: How do you handle allergens and customer dietary safety?
**Answer:**
Safety is built into both filtering and cart submission:
1. **Hard Allergen Filtering:** The recommendation engine runs an immutable hard filter: any dish containing an allergen listed in the diner's profile is excluded before rule or LLM processing.
2. **Cart Interception:** When adding a dish to the cart, the server checks the dish's allergen tags against the diner's profile. If a conflict is detected, the server returns `{ requiresAllergyAck: true }`, requiring the diner to explicitly acknowledge the warning on screen before the item is committed to the order.

### Q10: What would you improve or refactor next in this architecture?
**Answer:**
1. **Split-Bill Checkout:** Currently, the entire table order is paid as a single check. Allowing diners to select and pay for only their added items while maintaining atomic order state would significantly enhance diner experience.
2. **Dedicated Full-Screen KDS:** Build a low-latency Kitchen Display System with visual queue aging (color coding tickets over 15 minutes) and Web Audio chimes for kitchen tablets.
3. **Network Thermal Printing:** Integrate direct ESC/POS network printing to trigger physical kitchen tickets automatically upon order placement.

---

## 2. Hardening Audit: Bugs I Found and Fixed

During the recent security and reliability audit of the TableMind codebase, several critical edge cases and security vulnerabilities were identified and resolved:

### 1. The Token Prefix Search Vulnerability
- **The Issue:** Table QR tokens were originally matched using PostgreSQL pattern searches (`like.qr_token%`). If a token started with common characters or shared a prefix with an older regenerated token, a query could match the wrong table or open access prematurely.
- **The Fix:** Replaced pattern matching with strict equality (`eq("qr_token", token)`), backed by a unique B-tree index on `tables.qr_token`. Verified with automated regression tests in `hardening.test.ts`.

### 2. Double-Payment Race Condition
- **The Issue:** If a diner double-tapped the payment confirmation or if a webhook arrived simultaneously with the browser redirect, two parallel verification requests could both see the order status as `cart` before either marked it `paid`, resulting in duplicate loyalty point deductions and duplicate receipt emails.
- **The Fix:** Built the `complete_payment` stored procedure in PL/pgSQL using row-level locking (`SELECT ... FOR UPDATE`). The procedure checks order status atomically and returns `1` only for the first execution and `0` for subsequent attempts. Loyalty point deductions were moved inside this transaction.

### 3. Midnight Coupon Window Wraparound
- **The Issue:** Happy hour coupons operating across midnight (e.g. 23:00 to 03:00) were rejected at 01:00 because `01:00 >= 23:00` returned false under standard interval checks.
- **The Fix:** Implemented overnight shift logic in the coupon engine: when `start_time > end_time`, the condition evaluates as `(current >= start || current <= end)`. Added test cases verifying overnight window behavior.

### 4. React Rules of Hooks Violation on Feedback Route
- **The Issue:** In the post-order feedback screen (`feedback.$orderId.tsx`), a `useMemo` hook was placed after an early return conditional block checking for order loading state. This caused React to crash if the component re-rendered with differing hook call counts.
- **The Fix:** Hoisted all hooks above early return conditionals and ensured hook dependencies were properly memoized.

### 5. Sensitive Account Actions Without Re-Authentication
- **The Issue:** Critical operations like password modification and account deletion relied solely on an active session cookie. If a session was hijacked via an unlocked terminal, the account could be wiped.
- **The Fix:** Built a two-stage OTP verification system: sensitive actions require requesting a 6-digit OTP sent to the registered email, verifying it with a 5-minute validity window and a max of 3 attempts, and consuming a single-use verification token during the final action.
