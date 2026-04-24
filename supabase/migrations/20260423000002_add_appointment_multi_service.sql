ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS services JSONB,
  ADD COLUMN IF NOT EXISTS service_requests JSONB NOT NULL DEFAULT '[]'::jsonb