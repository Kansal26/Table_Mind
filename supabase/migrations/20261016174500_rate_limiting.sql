-- Migration: Postgres-backed atomic rate limiting
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 1,
  reset_at timestamptz NOT NULL
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rate_limits TO service_role;

-- Atomic rate limit check and counter increment
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count integer;
BEGIN
  -- Cleanup any expired key on insert/update atomically
  INSERT INTO public.rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_now + (p_window_seconds || ' seconds')::interval)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
          WHEN public.rate_limits.reset_at <= v_now THEN 1
          ELSE public.rate_limits.count + 1
        END,
        reset_at = CASE
          WHEN public.rate_limits.reset_at <= v_now THEN v_now + (p_window_seconds || ' seconds')::interval
          ELSE public.rate_limits.reset_at
        END
  RETURNING count INTO v_count;

  IF v_count > p_limit THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;
