# TableMind Architecture Guide

This document provides a detailed breakdown of the TableMind system architecture, execution flow, authentication model, and data integrity guarantees.

---

## 1. System Overview and Layered Boundaries

TableMind is structured as a full-stack TypeScript application using TanStack Start with Nitro as the deployment engine, Supabase (PostgreSQL) as the persistent store, and dedicated third-party integrations for payments (Razorpay), email dispatch (Resend), and speech parsing (Groq).

The system enforces four distinct layers of execution:

```
+-------------------------------------------------------------------+
| 1. Client Layer (Browser)                                         |
|    - React 19 UI & TanStack Router                                |
|    - Client-side cache (TanStack Query)                           |
|    - Web Speech API (audio capture & transcription)               |
|    - Supabase Realtime channel subscriptions                      |
+-------------------------------------------------------------------+
                                  |
                                  | RPC (JSON over HTTP POST)
                                  v
+-------------------------------------------------------------------+
| 2. Server Function Layer (TanStack Start Server Functions)        |
|    - Zod input validation                                         |
|    - Sliding-window rate limiting (PostgreSQL backed)             |
|    - Session & table token verification                           |
|    - Bearer token / Supabase Auth JWT extraction                  |
+-------------------------------------------------------------------+
                                  |
                                  | Native Service-Role Calls
                                  v
+-------------------------------------------------------------------+
| 3. Domain Core & Business Logic (Server Only)                     |
|    - Coupon rule engine & best discount optimizer                 |
|    - Hybrid recommendation pipeline & kitchen load assessment     |
|    - Razorpay payment signature & amount verification             |
|    - Two-stage OTP verification (sensitive settings actions)      |
+-------------------------------------------------------------------+
                                  |
                                  | PostgreSQL Client & RPC Calls
                                  v
+-------------------------------------------------------------------+
| 4. Persistence Layer (Supabase PostgreSQL)                        |
|    - Relational schema (tables, foreign keys, unique indexes)      |
|    - Row Level Security (RLS) policies                            |
|    - Atomic PL/pgSQL stored procedures (e.g., complete_payment)   |
+-------------------------------------------------------------------+
```

### Module Boundary Guarantees
- **Client Bundle Isolation:** Modules that access private environment variables (such as the Supabase service role key, Razorpay secret key, or Groq API key) never import into client route files. Vite tree-shaking and TanStack Start boundary markers ensure server-only code remains strictly within the server bundle.
- **Client Direct Reads:** Public catalogue data (such as restaurant metadata and menu item categories) can be read directly from the client using the public Supabase anonymous key under strict Row Level Security.
- **Server Function Writes:** All state mutations (placing orders, modifying cart item quantities, applying coupons, processing payments, and modifying administrative settings) must go through server functions.

---

## 2. Authentication & Authorization Model

TableMind supports two fundamentally different user personas with separate security contexts:

### 1. Diners (Session-Scoped Identity)
Diners do not need to register a traditional username and password to order. Requiring an account before dining creates friction that hurts restaurant throughput.
- **Credential:** The physical QR code at a table contains a cryptographically random Base64URL token.
- **Session Scoping:** When a diner visits `/table/:qrToken`, the server resolves the token against the database, verifies that the table is active, and binds the request to the table's active dining session.
- **Session Participants:** Individual diners generate a client device token and optional display name. This allows multiple phones at the same table to identify who added which dish while operating on a single unified cart.
- **Optional Diner Profile:** If a diner logs in via OTP/magic link, their user profile (dietary preferences, allergens, and loyalty points) links to the order, allowing them to earn points and receive personalized menu recommendations.

### 2. Restaurant Staff & Owners (Role-Based JWT)
Owners and staff authenticate via Supabase Auth using email and password.
- **Bearer Token Extraction:** Administrative server functions extract the `Authorization: Bearer <token>` header from incoming requests and verify the JWT via Supabase Auth.
- **Tenant Isolation:** Every administrative operation resolves the authenticated user's ID against the `restaurants` table. If the restaurant does not belong to the authenticated owner, the server function rejects the request immediately with an authorization error.
- **Sensitive Action OTP Guard:** Actions that permanently affect restaurant state (changing master passwords, deactivating accounts, or deleting accounts) require a verified 6-digit OTP sent to the owner's registered email before execution.

---

## 3. Data Flow & Request Lifecycle

A standard diner request (such as adding an item to the table cart) follows this end-to-end lifecycle:

1. **User Action:** The diner taps "Add to Cart" on a dish.
2. **Client Validation:** The client checks if the dish contains allergens conflicting with the diner's configured profile. If a conflict exists, an alert modal requires acknowledgment before proceeding.
3. **Transport:** The client invokes the `addToCart` server function, sending `{ qrToken, menuItemId, qty, notes, allergyOverrideAck, deviceToken }`.
4. **Server Validation:** The server function executes a Zod schema validator. If payload types or required fields fail, the request terminates with HTTP 400 without touching the database.
5. **Rate Limiting:** The server checks the diner's client identifier against a sliding-window rate limit table in PostgreSQL. If the request exceeds the allowed threshold, a 429 response returns.
6. **Scope Resolution:** The server verifies the `qrToken`, looks up the active dining session, and ensures the table is marked active.
7. **Business Logic & Pricing:** The server fetches the authoritative price directly from the `menu_items` table. Client-supplied prices are completely ignored.
8. **Database Write:** The item is upserted into `order_items` linked to the active `cart` order for that session.
9. **Cart Recalculation:** Subtotal, restaurant tax rate, discount, and grand total are recomputed server-side.
10. **Realtime Broadcast:** Supabase Realtime detects the database insert/update and broadcasts the change over the table's WebSocket channel, updating the cart badge and item list on all co-diners' screens simultaneously.

---

## 4. Payment Integrity, Concurrency & Idempotency

Handling payments in a shared-cart environment requires strict concurrency controls to prevent double charges, partial state updates, or race conditions.

### The Razorpay Integration Pipeline

```
Diner Browser               TanStack Server               PostgreSQL (RPC)           Razorpay Gateway
     |                             |                              |                         |
     |--- createRazorpayOrder ---->|                              |                         |
     |    (qrToken, orderId)       |--- Recalculate bill -------->|                         |
     |                             |    (subtotal, tax, credits)  |                         |
     |                             |<-- Authoritative paise ------|                         |
     |                             |                                                        |
     |                             |--- Create order (amount) ----------------------------->|
     |                             |<-- Returns razorpay_order_id --------------------------|
     |                             |                                                        |
     |                             |--- Store order_id on row --->|                         |
     |<-- Return order details ----|                              |                         |
     |                                                                                      |
     |=== Open Razorpay Modal & Complete Payment ===========================================|
     |                                                                                      |
     |--- verifyRazorpayPayment -->|                                                        |
     |    (signature, payment_id)  |--- Verify HMAC-SHA256 signature ---------------------->|
     |                             |--- Query payment amount ------------------------------>|
     |                             |    (confirms status == 'captured' && exact amount)     |
     |                             |                                                        |
     |                             |--- EXEC complete_payment(order_id, p_id) ------------->|
     |                             |    [Row-level lock on order]                           |
     |                             |    [Check status == 'cart' or 'pending']               |
     |                             |    [Set status = 'paid']                               |
     |                             |    [Close dining session]                              |
     |                             |    [Deduct redeemed loyalty points]                    |
     |                             |<-- Returns 1 (success) or 0 (duplicate) ---------------|
     |                             |                                                        |
     |                             |--- Dispatch receipt email (Resend)                     |
     |<-- Success confirmation ----|
```

### Prevention of Common Payment Pitfalls
- **Client Price Tampering:** The client never passes an amount to the payment gateway. The server recalculates totals using database item prices and taxes, converts to paise, and creates the order on Razorpay directly.
- **Amount Verification:** During verification, the server calls Razorpay's API to confirm that the payment is in the `captured` status and that the captured amount matches the database bill down to the last rupee.
- **Double-Verify Protection:** The state transition is executed via a stored procedure (`complete_payment`). The procedure uses row-level locking (`SELECT FOR UPDATE`) on the order record and checks if the order status is already `paid`. If a duplicate verification request or network retry arrives, the procedure returns `0` immediately without deducting loyalty points twice or emitting duplicate notifications.
- **Idempotent Loyalty Deduction:** Points deduction occurs within the same database transaction as the order status update. If the payment record cannot be updated, points are not deducted.

---

## 5. Error Handling and Resilience

The backend employs defensive patterns to ensure failures in third-party services degrade gracefully without crashing the core dining experience:

- **AI Recommendations Fallback:** The recommendation engine calls Groq using `Promise.race` against a 3000ms timeout. If the LLM call times out, fails, or throws due to rate limits, the system catches the error and seamlessly falls back to a deterministic rule-based engine (past order frequency, item co-occurrence, and overall popularity).
- **Email Receipt Failure Isolation:** Transactional receipt dispatch via Resend is wrapped in a try/catch block outside the payment transaction. If the email provider is temporarily unreachable, the order still finalizes successfully, and the diner sees their on-screen receipt.
- **Schema Drift Protection:** Automated tests (`schema-drift.test.ts`) assert that TypeScript types match the underlying PostgreSQL database schema, preventing runtime mismatches when database columns are modified.

---

## 6. How to Add a New Feature (End-to-End Guide)

When adding a new capability (e.g., adding a table reservation feature):

1. **Database Migration:** Create a new migration file in `supabase/migrations/` defining the required tables, foreign keys, RLS policies, and indexes. Apply the migration in your local/staging Supabase instance.
2. **Regenerate Types:** Update `src/integrations/supabase/types.ts` so the TypeScript compiler recognizes new tables and columns.
3. **Create Server Function:** Add a server function in `src/lib/<feature>.functions.ts` using `createServerFn`. Define input validation using Zod and wrap execution in the appropriate rate limiter.
4. **Implement Domain Logic:** If the feature requires complex calculations or service-role database access, create a companion module `src/lib/<feature>.server.ts` to keep the server function file clean.
5. **Connect Client Interface:** In the route component (e.g., `src/routes/`), invoke the server function using TanStack Query (`useQuery` or `useMutation`) and render UI components.
6. **Write Automated Tests:** Create a test file `src/lib/<feature>.functions.test.ts` mocking the Supabase client and verifying validation, authorization, and error handling. Verify that `npx vitest --run` and `npx tsc --noEmit` pass.
