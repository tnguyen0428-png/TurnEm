-- Add a "caution" flag to appointments. When true the appointment block in
-- the book view is painted with diagonal warning stripes so the salon can
-- spot risky bookings at a glance (problem clients, unpaid history, etc.).
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS caution boolean NOT NULL DEFAULT false;
