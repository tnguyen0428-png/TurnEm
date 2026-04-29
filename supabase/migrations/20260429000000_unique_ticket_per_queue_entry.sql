-- Enforce 1:1 between queue_entries and tickets at the DB level.
--
-- Until now we relied on the JS sync layer to skip auto-creating a ticket if
-- one already existed for a given queue entry (`fetchTicketByQueueEntry`),
-- but the check-then-insert is racy across renders, tabs, and devices. A
-- partial unique index makes the second insert fail with a constraint
-- violation, which is the only way to be sure two parallel writers can never
-- both win.
--
-- The index is partial because tickets created via the "+ New Walk-in"
-- button on the Register screen have queue_entry_id = NULL, and we want
-- those to be allowed in unlimited numbers.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_queue_entry_id
  ON tickets (queue_entry_id)
  WHERE queue_entry_id IS NOT NULL;
