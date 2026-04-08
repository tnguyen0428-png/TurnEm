/*
  # Add fourth position special flag to manicurists

  1. Changes
    - `manicurists` table: adds `has_fourth_position_special` boolean column (default false)
      - Tracks whether a manicurist has been assigned the 4th position special for the day
      - Persists across the day so the checkmark stays visible

  2. Notes
    - Safe migration using IF NOT EXISTS pattern
    - No data loss; defaults to false for all existing rows
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'has_fourth_position_special'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN has_fourth_position_special boolean NOT NULL DEFAULT false;
  END IF;
END $$;
