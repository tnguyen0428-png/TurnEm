/*
  # Add requested_services column to completed_services

  Tracks which services in a completion had a requested manicurist at assign time.
  Optional / nullable — old rows without it default to empty array and the front-end
  falls back to turn-value inference for those entries.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'completed_services' AND column_name = 'requested_services'
  ) THEN
    ALTER TABLE completed_services ADD COLUMN requested_services text[] NOT NULL DEFAULT '{}';
  END IF;
END $$;
