/*
  # Add is_fourth_position_special to salon_services

  Adds a boolean flag to mark services that are given out to the person in the 4th queue position.

  1. Changes
    - `salon_services`: new column `is_fourth_position_special` (boolean, default false)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salon_services' AND column_name = 'is_fourth_position_special'
  ) THEN
    ALTER TABLE salon_services ADD COLUMN is_fourth_position_special boolean NOT NULL DEFAULT false;
  END IF;
END $$;
