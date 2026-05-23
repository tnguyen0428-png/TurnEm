-- Add an "is_walk_in" flag to appointments. Set to true when the appt block
-- is auto-synthesized by the queue-assign flow (walk-in path). The
-- AppointmentBookView renders a flashing pink "W" badge on these so the
-- receptionist can spot auto-placed blocks and drag them to a real slot.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS is_walk_in boolean NOT NULL DEFAULT false;
