/*
  # Add is_appointment column to queue_entries

  1. Modified Tables
    - `queue_entries`
      - Add `is_appointment` (boolean, not null, default false) - indicates if the queue entry came from a checked-in appointment

  2. Important Notes
    - Existing rows default to false since they were walk-in clients
    - This column is used to prioritize appointment clients in the waiting queue
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'queue_entries' AND column_name = 'is_appointment'
  ) THEN
    ALTER TABLE queue_entries ADD COLUMN is_appointment boolean NOT NULL DEFAULT false;
  END IF;
END $$;