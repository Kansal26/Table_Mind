-- ============================================================================
-- PAYMENT INTEGRITY MIGRATION
-- Adds Razorpay tracking columns and an atomic payment-completion function.
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1. Add Razorpay tracking columns to orders
-- razorpay_order_id: the Razorpay order we created for THIS order
-- amount_paise:      the amount (in paise) locked at creation time
-- razorpay_payment_id: filled after successful verification (UNIQUE
--                      so a payment can never be reused on another order)

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS razorpay_order_id text,
  ADD COLUMN IF NOT EXISTS amount_paise      integer,
  ADD COLUMN IF NOT EXISTS razorpay_payment_id text;

-- UNIQUE constraint prevents replaying the same payment on a different order
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_razorpay_payment_id_key'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_razorpay_payment_id_key UNIQUE (razorpay_payment_id);
  END IF;
END
$$;

-- 2. Atomic payment-completion function
--    Called by the application's verifyRazorpayPaymentFn via supabaseAdmin (service_role).
--    Locks the row with FOR UPDATE, flips status → 'paid', deducts loyalty
--    points idempotently, and closes the session — all inside one transaction.
--
--    Returns the number of rows affected (1 = this call flipped it,
--    0 = already paid by a prior call).

CREATE OR REPLACE FUNCTION public.complete_payment(
  p_order_id          uuid,
  p_razorpay_payment_id text,
  p_points_to_deduct  integer DEFAULT 0,
  p_user_id           uuid    DEFAULT NULL,
  p_restaurant_id     uuid    DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id uuid;
  v_affected   integer := 0;
  v_existing_deduction integer;
BEGIN
  -- Lock the order row and try to flip it to 'paid'
  UPDATE orders
  SET    status = 'paid',
         razorpay_payment_id = p_razorpay_payment_id
  WHERE  id = p_order_id
    AND  status <> 'paid'
  RETURNING session_id INTO v_session_id;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  -- If we didn't flip (already paid), return 0 immediately.
  IF v_affected = 0 THEN
    RETURN 0;
  END IF;

  -- Idempotent loyalty-point deduction: only insert if no deduction
  -- for this order already exists.
  IF p_points_to_deduct > 0
     AND p_user_id IS NOT NULL
     AND p_restaurant_id IS NOT NULL
  THEN
    SELECT 1 INTO v_existing_deduction
    FROM   wallet_transactions
    WHERE  order_id = p_order_id
      AND  points < 0
    LIMIT  1;

    IF v_existing_deduction IS NULL THEN
      INSERT INTO wallet_transactions (user_id, restaurant_id, amount, points, reason, order_id)
      VALUES (p_user_id, p_restaurant_id, 0, -p_points_to_deduct,
              'Redeemed on order', p_order_id);
    END IF;
  END IF;

  -- Close the dining session
  UPDATE sessions
  SET    status = 'closed'
  WHERE  id = v_session_id;

  RETURN v_affected;
END;
$$;

-- Only service_role may call this function
REVOKE EXECUTE ON FUNCTION public.complete_payment(uuid, text, integer, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_payment(uuid, text, integer, uuid, uuid)
  TO service_role;
