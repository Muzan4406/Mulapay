-- Additive only: the cancelled worker already created the administration tables.
-- Never drop financial or identity data when applying this migration.
ALTER TABLE public.mulapay_blacklisted_phones ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS mulapay_api_usage_key_created_idx ON public.mulapay_api_usage (key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mulapay_route_reservation_usage_idx ON public.mulapay_route_reservations (route_id, day, state);
CREATE INDEX IF NOT EXISTS mulapay_merchant_messages_queue_idx ON public.mulapay_merchant_messages (status, created_at);
