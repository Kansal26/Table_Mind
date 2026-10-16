# TableMind

**TableMind** is an AI-powered, real-time QR ordering and dine-in management platform built with TanStack Start, React 19, Supabase (PostgreSQL), and Tailwind CSS.

---

## What Really Works (Current State)

### Diner Web Experience (`/table/:qrToken`)
- **Table Session Scoping:** Diners scan a cryptographically secure Base64URL table QR token to join an active dining session.
- **Shared Real-Time Cart:** Diners at the same table see items added by co-diners in real-time via Supabase Realtime channels.
- **Interactive Menu:** Filter dishes by dietary tags (Vegetarian, Vegan, Gluten-Free) and allergen warnings.
- **AI Voice Ordering:** Diners tap a microphone to speak their order in natural language. Audio is transcribed via Web Speech API and parsed into dish items, quantities, and notes via Groq (`llama-3.3-70b-versatile` by default), validated strictly against restaurant menu IDs using Zod.
- **Scoped Recommendations:** Suggested items based on user dietary profile, recent popularity, and co-occurrence patterns scoped strictly to the current restaurant.
- **Service & Assistance:** "Call Waiter" and "Request Bill" buttons dispatch real-time alerts directly to the staff.
- **Coupons & Offers:** Server-evaluated coupons supporting minimum spend thresholds, item-specific discounts, and time-of-day windows (including overnight shifts).
- **Loyalty Wallet & Credits:** Diners can redeem accumulated loyalty points for rupee discounts directly on the checkout screen.
- **Checkout & Payments:** Integration with Razorpay SDK with atomic server-side HMAC-SHA256 signature verification and order state finalization.
- **Feedback & Loyalty Reward:** Post-payment survey awarding loyalty points for dish ratings, comments, and answers.
- **Itemized Email Receipts:** Automated HTML email receipts sent via Resend with complete HTML entity escaping.

### Restaurant Management (`/admin/*`)
- **Dashboard (`/admin/dashboard`):** Real-time order cards, live kitchen load statuses (`pending` -> `preparing` -> `served` -> `completed`), and revenue metrics.
- **Menu Management (`/admin/menu`):** Add, update, re-order, and soft-delete dishes with allergens, tags, categories, and image URLs.
- **Tables & QR Generation (`/admin/tables`):** Add tables, toggle table active state, regenerate QR codes, download single PNGs, or export a multi-page printable A4 PDF booklet.
- **Branding Customization (`/admin/branding`):** Configure restaurant name, logo, tagline, and brand accent colors.
- **Promotions & Coupons (`/admin/coupons`):** Create time-window or spend-based coupons.
- **Loyalty Program Settings (`/admin/loyalty`):** Toggle points per rupee, redemption minimums, and feedback rewards.
- **Security & Account Management (`/admin/settings`):** Two-stage OTP verification (3 attempts, 5-minute validity) required for password changes, account deactivation, and account deletion.

---

## Planned Roadmap (Not Yet Implemented)
- **Split-Bill Payments:** Allowing individual diners at the same table to pay for only their selected items.
- **Dedicated KDS Screen:** Sound-alerted full-screen Kitchen Display System view for kitchen tablets.
- **Thermal Printer Support:** ESC/POS network printer integration for automatic kitchen order tickets (KOT).
- **Multi-Language Menus:** Real-time localized menu translations (e.g. Hindi, Spanish, French).
- **SMS Notifications:** Transactional SMS via Twilio / Fast2SMS alongside Resend email.

---

## Environment Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in the required credentials:
   - **Supabase:**
     - `VITE_SUPABASE_URL` / `SUPABASE_URL`: Your Supabase Project URL (`https://xyz.supabase.co`)
     - `VITE_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY`: Supabase anon/public key (safe for browser)
     - `SUPABASE_SERVICE_ROLE_KEY`: Supabase secret service role key (**server only**, never prefix with `VITE_`)
   - **Razorpay:**
     - `VITE_RAZORPAY_KEY_ID`: Razorpay Public Key ID (`rzp_test_...` or `rzp_live_...`)
     - `RAZORPAY_KEY_SECRET`: Razorpay Secret Key (**server only**)
   - **AI Voice Ordering:**
     - `GROQ_API_KEY`: Groq Cloud API Key
     - `GROQ_VOICE_MODEL`: (Optional, defaults to `llama-3.3-70b-versatile`)
   - **Email Receipts:**
     - `RESEND_API_KEY`: Resend API Key (`re_...`)
     - `EMAIL_FROM`: Configurable verified sender (defaults to `onboarding@resend.dev`)
     - `RESTAURANT_NOTIFICATION_EMAIL`: Fallback recipient for admin alerts
   - **App URL:**
     - `VITE_APP_URL` / `PUBLIC_URL`: App host URL (e.g. `http://localhost:5173` or `https://tablemind.com`)

3. Verify key connectivity:
   ```bash
   npm run check:keys
   ```

---

## Database Migrations

Apply the migration scripts in the Supabase SQL Editor in the following order:

1. `supabase/migrations/20260803095246_72b11d27-7025-4d66-bc43-82dcab909be2.sql` (Initial core schema)
2. `supabase/migrations/20260803100508_66dc81e7-aa23-4c81-aa6e-cedcc188b439.sql` (RLS policies)
3. `supabase/migrations/20260804110355_20b5934f-551c-425e-bcb0-6e54f0e59582.sql` (Sessions & waiter calls)
4. `supabase/migrations/20260804110433_5202e632-8e6c-49e8-8359-35ccbeedeee1.sql` (Loyalty & coupons)
5. `supabase/migrations/20261016143600_security_lockdown.sql` (RLS lockdown & account cleanup RPC)
6. `supabase/migrations/20261016150300_payments.sql` (Razorpay payment metadata & complete_payment RPC)
7. `supabase/migrations/20261016161500_otp_enforcement.sql` (Two-stage OTP enforcement & rate limits)
8. `supabase/migrations/20261016171500_baseline_schema.sql` (Missing tables sync & schema drift alignment)
9. `supabase/migrations/20261016174500_rate_limiting.sql` (Postgres sliding-window rate_limits table & RPC)
10. `supabase/migrations/20261016175000_restaurant_tax_rate.sql` (Per-restaurant tax_rate column)

---

## Development & Deployment

### Local Development
```bash
# Install dependencies
npm install

# Run type check
npx tsc --noEmit

# Run unit and hardening tests
npm test

# Run local development server
npm run dev
```

### Production Build
```bash
# Build production bundle with Nitro server
npm run build

# Preview build locally
npx vite preview
```

### Deployment Targets
The app is built with **TanStack Start** and **Nitro**:
- **Cloudflare Pages / Workers:** Deploy `.output/public` as static assets and `.output/server` as worker (pre-configured in `wrangler.json`).
- **Node.js / Docker:** Run `node .output/server/index.mjs` with your environment variables configured.
