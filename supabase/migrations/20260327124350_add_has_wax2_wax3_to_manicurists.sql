/*
  # Add has_wax2 and has_wax3 flags to manicurists

  1. Changes
    - `manicurists` table: adds `has_wax2` and `has_wax3` boolean columns (default false)
      - These mirror the check2/check3 pattern, providing three wax toggle slots
      - Only shown on cards for manicurists who have the Waxing skill

  2. Notes
    - Safe migration using IF NOT EXISTS pattern
    - No data loss; defaults to false for existing rows
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'has_wax2'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN has_wax2 boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'has_wax3'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN has_wax3 boolean NOT NULL DEFAULT false;
  END IF;
END $$;
