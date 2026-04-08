/*
  # Add check2 and check3 flags to manicurists

  1. Changes
    - `manicurists` table: adds `has_check2` and `has_check3` boolean columns (default false)
      - These represent the 2nd and 3rd daily checkmark slots per manicurist
      - All three checks persist for the day

  2. Notes
    - Safe migration using IF NOT EXISTS pattern
    - No data loss; defaults to false for existing rows
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'has_check2'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN has_check2 boolean NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'has_check3'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN has_check3 boolean NOT NULL DEFAULT false;
  END IF;
END $$;
