-- Add parent_queue_id to queue_entries.
--
-- This is the "visit id" — for original entries it equals the entry's own id;
-- for SPLIT_AND_ASSIGN children (one entry per manicurist working a single
-- multi-service client) it points back to the original entry's id.
--
-- Tickets are keyed off this so a client whose 3 services were split across
-- 3 manicurists still ends up on a single ticket at checkout.
--
-- Also: backfill existing rows so parent_queue_id = id where it's NULL,
-- which is the right default for any entry that wasn't created via a split.

ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS parent_queue_id text;

UPDATE queue_entries
SET parent_queue_id = id
WHERE parent_queue_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_queue_entries_parent_queue_id
  ON queue_entries (parent_queue_id);
