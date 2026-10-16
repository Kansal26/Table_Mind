-- Migration: Per-restaurant tax rate setting
ALTER TABLE IF EXISTS public.restaurants
  ADD COLUMN IF NOT EXISTS tax_rate numeric NOT NULL DEFAULT 0.05;
