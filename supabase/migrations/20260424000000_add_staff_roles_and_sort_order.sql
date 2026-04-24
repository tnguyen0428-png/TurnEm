-- Add sort_order, show_in_book, and is_receptionist to manicurists
ALTER TABLE manicurists
  ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS show_in_book BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_receptionist BOOLEAN DEFAULT FALSE;

-- Backfill sort_order for existing rows using a stable default (by id for repeatability)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn
  FROM manicurists
)
UPDATE manicurists
SET sort_order = ranked.rn
FROM ranked
WHERE manicurists.id = ranked.id;
