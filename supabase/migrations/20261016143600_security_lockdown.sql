-- ============================================================================
-- VERIFICATION QUERIES (Run these in the Supabase SQL Editor to verify lockdown)
-- ============================================================================
-- 1. Verify routine privileges for delete_restaurant_account:
--    SELECT routine_schema, routine_name, grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public'
--      AND routine_name = 'delete_restaurant_account';
--    -- Expected: Only 'service_role' (or postgres superuser) has EXECUTE.
--    -- Neither 'PUBLIC', 'anon', nor 'authenticated' should have EXECUTE.
--
-- 2. Verify search_path on delete_restaurant_account:
--    SELECT proname, proconfig
--    FROM pg_proc
--    JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
--    WHERE nspname = 'public' AND proname = 'delete_restaurant_account';
--    -- Expected: proconfig contains 'search_path=public'.
--
-- 3. Verify column-level privileges on public.tables:
--    SELECT table_schema, table_name, column_name, grantee, privilege_type
--    FROM information_schema.column_privileges
--    WHERE table_schema = 'public'
--      AND table_name = 'tables'
--      AND privilege_type = 'SELECT'
--      AND grantee IN ('anon', 'authenticated')
--    ORDER BY column_name, grantee;
--    -- Expected: 'anon' and 'authenticated' only have SELECT on:
--    --   created_at, id, is_active, label, restaurant_id, seat_count.
--    --   qr_token must NOT appear for anon or authenticated.
--
-- 4. Verify column-level privileges on public.restaurants:
--    SELECT table_schema, table_name, column_name, grantee, privilege_type
--    FROM information_schema.column_privileges
--    WHERE table_schema = 'public'
--      AND table_name = 'restaurants'
--      AND privilege_type = 'SELECT'
--      AND grantee IN ('anon', 'authenticated')
--    ORDER BY column_name, grantee;
--    -- Expected: 'anon' and 'authenticated' only have SELECT on:
--    --   address, city, created_at, cuisine_type, id, is_active,
--    --   latitude, logo_url, longitude, name, tagline.
--    --   owner_id and deactivated_at must NOT appear for anon or authenticated.
--
-- 5. Verify RLS is enabled on ALL public tables:
--    SELECT tablename, rowsecurity
--    FROM pg_tables
--    WHERE schemaname = 'public'
--    ORDER BY tablename;
--    -- Expected: rowsecurity = true for all tables.
--
-- 6. Verify table privileges on server-only tables:
--    SELECT table_schema, table_name, grantee, privilege_type
--    FROM information_schema.table_privileges
--    WHERE table_schema = 'public'
--      AND table_name IN (
--        'wallets', 'wallet_transactions', 'otp_verifications', 'feedback',
--        'coupons', 'order_discounts', 'recommendation_logs',
--        'session_participants', 'waiter_calls', 'loyalty_settings',
--        'orders', 'sessions', 'order_items'
--      )
--      AND grantee IN ('anon', 'authenticated');
--    -- Expected: Zero rows returned (no privileges for anon/authenticated).
-- ============================================================================

-- ============================================================================
-- 1. FUNCTION LOCKDOWN: delete_restaurant_account(uuid)
-- ============================================================================
-- Enforce explicit search_path = public to mitigate schema poisoning
ALTER FUNCTION public.delete_restaurant_account(uuid) SET search_path = public;

-- Revoke execution from untrusted roles
REVOKE ALL ON FUNCTION public.delete_restaurant_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_restaurant_account(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.delete_restaurant_account(uuid) FROM authenticated;

-- Grant execution strictly to service_role (invoked via Supabase Admin API in server functions)
GRANT EXECUTE ON FUNCTION public.delete_restaurant_account(uuid) TO service_role;


-- ============================================================================
-- 2. COLUMN-LEVEL LOCKDOWN: public.tables (protect qr_token)
-- ============================================================================
-- Revoke existing broad table-level SELECT from anon and authenticated
REVOKE SELECT ON TABLE public.tables FROM anon;
REVOKE SELECT ON TABLE public.tables FROM authenticated;

-- Grant SELECT only on non-secret columns
GRANT SELECT (id, restaurant_id, label, is_active, seat_count, created_at)
  ON TABLE public.tables TO anon;

GRANT SELECT (id, restaurant_id, label, is_active, seat_count, created_at)
  ON TABLE public.tables TO authenticated;


-- ============================================================================
-- 3. COLUMN-LEVEL LOCKDOWN: public.restaurants (protect owner_id & deactivated_at)
-- ============================================================================
-- Revoke existing broad table-level SELECT from anon and authenticated
REVOKE SELECT ON TABLE public.restaurants FROM anon;
REVOKE SELECT ON TABLE public.restaurants FROM authenticated;

-- Grant SELECT only on non-sensitive columns listed in src/integrations/supabase/types.ts
-- (strictly excluding owner_id and deactivated_at)
GRANT SELECT (id, name, address, city, cuisine_type, is_active, latitude, logo_url, longitude, tagline, created_at)
  ON TABLE public.restaurants TO anon;

GRANT SELECT (id, name, address, city, cuisine_type, is_active, latitude, logo_url, longitude, tagline, created_at)
  ON TABLE public.restaurants TO authenticated;


-- ============================================================================
-- 4. ENABLE ROW LEVEL SECURITY ON ALL PUBLIC TABLES
-- ============================================================================
ALTER TABLE IF EXISTS public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.otp_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.order_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.recommendation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.waiter_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.loyalty_settings ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 5. SERVER-ONLY TABLES LOCKDOWN
-- ============================================================================
-- Tables treated as SERVER-ONLY (and justification):
--  - wallets: Contains customer wallet balances and credit ledger; mutations and reads must be strictly server-validated.
--  - wallet_transactions: Financial credit/point debit ledger; tampering by clients could generate free money.
--  - otp_verifications: Contains verification code hashes, salts, and attempt counters; must never be exposed to prevent brute force or token exposure.
--  - feedback: Customer ratings, survey answers, and sentiment; submitted and accessed solely via server functions.
--  - coupons: Promotional discounts, max uses, rules, and usage stats; evaluated server-side to prevent client discount spoofing.
--  - order_discounts: Links applied coupons to orders with dollar discounts; strictly managed server-side.
--  - recommendation_logs: AI dish recommendation telemetry; internal server logging.
--  - session_participants: Dining group participant device tokens and guest names; resolved via server function with session scope.
--  - waiter_calls: Assistance requests and statuses; managed and dispatched through authenticated server actions.
--  - loyalty_settings: Restaurant configuration for point conversion and redemption rules; owner-configured and server-enforced.
--  - orders: Dining session orders and line totals; already server-only, reinforced.
--  - sessions: Dining table sessions and access tokens; already server-only, reinforced.
--  - order_items: Order line items; already server-only, reinforced.

-- Revoke all permissions from anon and authenticated on server-only tables
REVOKE ALL ON TABLE public.wallets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.wallet_transactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.otp_verifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feedback FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.coupons FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_discounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.recommendation_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.session_participants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.waiter_calls FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.loyalty_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_items FROM PUBLIC, anon, authenticated;

-- Ensure service_role has full access for backend server functions
GRANT ALL ON TABLE public.wallets TO service_role;
GRANT ALL ON TABLE public.wallet_transactions TO service_role;
GRANT ALL ON TABLE public.otp_verifications TO service_role;
GRANT ALL ON TABLE public.feedback TO service_role;
GRANT ALL ON TABLE public.coupons TO service_role;
GRANT ALL ON TABLE public.order_discounts TO service_role;
GRANT ALL ON TABLE public.recommendation_logs TO service_role;
GRANT ALL ON TABLE public.session_participants TO service_role;
GRANT ALL ON TABLE public.waiter_calls TO service_role;
GRANT ALL ON TABLE public.loyalty_settings TO service_role;
GRANT ALL ON TABLE public.orders TO service_role;
GRANT ALL ON TABLE public.sessions TO service_role;
GRANT ALL ON TABLE public.order_items TO service_role;

-- Drop any lingering permissive or anon policies on server-only tables (idempotent)
DROP POLICY IF EXISTS "Public can view session_participants" ON public.session_participants;
DROP POLICY IF EXISTS "Anyone can join session" ON public.session_participants;
DROP POLICY IF EXISTS "Allow anon read" ON public.coupons;
DROP POLICY IF EXISTS "Coupons are publicly readable" ON public.coupons;
DROP POLICY IF EXISTS "Feedback is publicly insertable" ON public.feedback;
DROP POLICY IF EXISTS "Feedback is publicly readable" ON public.feedback;
DROP POLICY IF EXISTS "Waiter calls are publicly readable" ON public.waiter_calls;
DROP POLICY IF EXISTS "Waiter calls are publicly insertable" ON public.waiter_calls;
DROP POLICY IF EXISTS "Loyalty settings are publicly readable" ON public.loyalty_settings;
DROP POLICY IF EXISTS "Recommendation logs are publicly readable" ON public.recommendation_logs;
DROP POLICY IF EXISTS "Order discounts are publicly readable" ON public.order_discounts;
DROP POLICY IF EXISTS "Wallets are publicly readable" ON public.wallets;
DROP POLICY IF EXISTS "Wallet transactions are publicly readable" ON public.wallet_transactions;
