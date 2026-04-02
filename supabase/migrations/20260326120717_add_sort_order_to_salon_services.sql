/*
  # Add sort_order column to salon_services

  1. Modified Tables
    - `salon_services`
      - Added `sort_order` (integer, default 0) - controls display order of services in the list

  2. Data Migration
    - Sets initial sort_order values based on existing row order

  3. Important Notes
    - Non-destructive change, only adds a new column
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salon_services' AND column_name = 'sort_order'
  ) THEN
    ALTER TABLE salon_services ADD COLUMN sort_order integer DEFAULT 0;
  END IF;
END $$;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY category, name) - 1 AS rn
  FROM salon_services
)
UPDATE salon_services
SET sort_order = ranked.rn
FROM ranked
WHERE salon_services.id = ranked.id;