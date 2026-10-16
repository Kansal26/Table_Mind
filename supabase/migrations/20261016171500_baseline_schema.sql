-- Baseline schema migration: Reconciles missing tables and columns to achieve complete
-- parity with the live Supabase schema as discovered in supabase/live-schema.csv.
-- Uses CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- so that a fresh Supabase project can be initialized from scratch, or an existing one migrated safely.

-- 1. Core table column extensions
ALTER TABLE IF EXISTS public.restaurants
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS tagline text,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS banner_url text,
  ADD COLUMN IF NOT EXISTS cuisine_type text,
  ADD COLUMN IF NOT EXISTS latitude numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_id uuid;

ALTER TABLE IF EXISTS public.tables
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS qr_token text,
  ADD COLUMN IF NOT EXISTS seat_count integer DEFAULT 4,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

ALTER TABLE IF EXISTS public.sessions
  ADD COLUMN IF NOT EXISTS access_token text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS participant_count integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz DEFAULT now();

ALTER TABLE IF EXISTS public.menu_items
  ADD COLUMN IF NOT EXISTS badge text,
  ADD COLUMN IF NOT EXISTS prep_time_min integer DEFAULT 10,
  ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_featured boolean DEFAULT false;

ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS guest_email text,
  ADD COLUMN IF NOT EXISTS kitchen_status text DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits_applied numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS use_credits boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS points_redeemed integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS razorpay_order_id text,
  ADD COLUMN IF NOT EXISTS amount_paise integer,
  ADD COLUMN IF NOT EXISTS razorpay_payment_id text;

ALTER TABLE IF EXISTS public.order_items
  ADD COLUMN IF NOT EXISTS added_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS added_by_name text,
  ADD COLUMN IF NOT EXISTS added_by_device_token text,
  ADD COLUMN IF NOT EXISTS allergy_override_ack boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS customizations jsonb DEFAULT '{}'::jsonb;

-- 2. Coupons table
CREATE TABLE IF NOT EXISTS public.coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  rule_json jsonb NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 3. Loyalty Settings table
CREATE TABLE IF NOT EXISTS public.loyalty_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  enabled boolean DEFAULT false,
  points_for_rating integer DEFAULT 0,
  points_for_comment integer DEFAULT 0,
  points_for_question integer DEFAULT 0,
  points_per_rupee numeric DEFAULT 0,
  min_order_value_to_redeem numeric DEFAULT 0,
  max_points_redeemable_per_order integer DEFAULT 0,
  points_expiry_days integer,
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT loyalty_settings_restaurant_id_key UNIQUE (restaurant_id)
);

-- 4. Feedback table
CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  rating integer NOT NULL,
  comment text,
  structured_answers jsonb,
  credit_awarded numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT feedback_order_id_key UNIQUE (order_id)
);

-- 5. Order Discounts table
CREATE TABLE IF NOT EXISTS public.order_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  coupon_id uuid REFERENCES public.coupons(id) ON DELETE SET NULL,
  discount_amount numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 6. Session Participants table
CREATE TABLE IF NOT EXISTS public.session_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  device_token text NOT NULL,
  guest_name text,
  user_id uuid,
  joined_at timestamptz DEFAULT now()
);

-- 7. Waiter Calls table
CREATE TABLE IF NOT EXISTS public.waiter_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  reason text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

-- 8. Wallets table
CREATE TABLE IF NOT EXISTS public.wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  balance numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 9. Wallet Transactions table
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  amount numeric NOT NULL,
  points integer,
  reason text,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 10. Recommendation Logs table
CREATE TABLE IF NOT EXISTS public.recommendation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  reason text NOT NULL,
  source text DEFAULT 'rule',
  added_to_cart boolean NOT NULL DEFAULT false,
  shown_at timestamptz NOT NULL DEFAULT now()
);

-- 11. OTP Verifications table (baseline)
CREATE TABLE IF NOT EXISTS public.otp_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  purpose text NOT NULL,
  code_hash text NOT NULL,
  salt text NOT NULL,
  attempts integer DEFAULT 0,
  max_attempts integer DEFAULT 5,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 12. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_coupons_restaurant_id ON public.coupons (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_order_discounts_order_id ON public.order_discounts (order_id);
CREATE INDEX IF NOT EXISTS idx_session_participants_session ON public.session_participants (session_id, device_token);
CREATE INDEX IF NOT EXISTS idx_waiter_calls_restaurant_status ON public.waiter_calls (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_restaurant ON public.wallet_transactions (user_id, restaurant_id);
CREATE INDEX IF NOT EXISTS idx_recommendation_logs_session_item ON public.recommendation_logs (session_id, item_id);
