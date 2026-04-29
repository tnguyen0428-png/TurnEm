-- Relax tickets.queue_entry_id from a hard FK to a logical visit id.
--
-- We now use queue_entry_id as the "visit id" that all SPLIT_AND_ASSIGN
-- siblings of a multi-service client share. The original queue entry that
-- the visit id was derived from often gets removed from queue_entries
-- when the split happens (the parent is replaced by per-manicurist children
-- in state, and syncQueue propagates the delete). We don't want that
-- deletion to wipe the ticket's link, so we drop the FK constraint.
--
-- Uniqueness is still enforced by the partial unique index on
-- tickets.queue_entry_id WHERE queue_entry_id IS NOT NULL (added in
-- 20260429000000_unique_ticket_per_queue_entry.sql).

DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'tickets'::regclass
    AND contype = 'f'
    AND conkey = (SELECT array_agg(attnum) FROM pg_attribute
                  WHERE attrelid = 'tickets'::regclass AND attname = 'queue_entry_id');
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tickets DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;
