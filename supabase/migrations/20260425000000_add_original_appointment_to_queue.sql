-- Stores a snapshot of the original Appointment when a queue_entry was promoted
-- from the appointment book via the "Q" key. The Revert button on a waiting
-- queue card uses this to restore the appointment back into its original date,
-- time, and column slot. NULL for queue entries that were never an appointment
-- (walk-ins added directly to the queue).
ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS original_appointment jsonb;
