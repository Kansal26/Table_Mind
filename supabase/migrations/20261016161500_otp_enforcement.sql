-- ============================================================================
-- Migration: 20261016161500_otp_enforcement.sql
-- Description: Enforce server-side OTP verification with two-stage verification
--              (verified_at and consumed_at) and atomic consumption / attempt tracking.
-- ============================================================================

-- 1. Add verified_at and consumed_at columns to otp_verifications
ALTER TABLE public.otp_verifications
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

-- 2. Index for fast querying of verified, unconsumed OTPs
CREATE INDEX IF NOT EXISTS idx_otp_verifications_user_purpose_verified
  ON public.otp_verifications (user_id, purpose, verified_at)
  WHERE verified_at IS NOT NULL AND consumed_at IS NULL;

-- 3. Atomic attempt increment function to prevent parallel guess race conditions
CREATE OR REPLACE FUNCTION public.increment_otp_attempts(p_otp_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer;
BEGIN
  UPDATE public.otp_verifications
  SET attempts = attempts + 1
  WHERE id = p_otp_id
  RETURNING attempts INTO v_attempts;

  RETURN v_attempts;
END;
$$;

-- 4. Atomic OTP consumption function (must be verified within the last 5 minutes)
CREATE OR REPLACE FUNCTION public.consume_verified_otp(
  p_user_id uuid,
  p_purpose text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.otp_verifications
  SET consumed_at = now()
  WHERE id = (
    SELECT id
    FROM public.otp_verifications
    WHERE user_id = p_user_id
      AND purpose = p_purpose
      AND verified_at >= now() - interval '5 minutes'
      AND consumed_at IS NULL
    ORDER BY verified_at DESC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$;
