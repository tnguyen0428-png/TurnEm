/*
  # Add has_wax flag to manicurists

  1. Changes
    - `manicurists` table: adds `has_wax` boolean column (default false)
      - Indicates whether a manicurist has been flagged as a wax specialist for the day
      - Displays as a "W" indicator on the manicurist card in the queue view

  2. Notes
    - Safe migration using IF NOT EXISTS pattern
    - No data loss; defaults to false for existing rows
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'has_wax'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN has_wax boolean NOT NULL DEFAULT false;
  END IF;
END $$;
