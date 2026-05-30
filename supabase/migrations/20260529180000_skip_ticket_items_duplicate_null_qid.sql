-- Defense-in-depth against the mergeOpenTicketsByClient phantom-line bug.
--
-- Root cause (see lib/tickets.ts mergeOpenTicketsByClient): when two open
-- tickets for the same client get merged, the secondary's items were mapped
-- without queue_entry_id, so they landed on the primary with queue_entry_id =
-- NULL. The RegisterScreen reconcile effect re-fires on every state.completed
-- change, repeatedly creating a fresh secondary that got merged again,
-- duplicating the same NULL-qid service line on every cycle. Witnessed on
-- ticket #29 (Rebecca, 2026-05-29) — 13+ phantom Gel Pedicure rows in 5 min.
--
-- The code path is fixed by preserving queue_entry_id in the merge mapping
-- (same commit). This trigger is the defense-in-depth so a stale client (or
-- any future regression) cannot duplicate NULL-qid service lines.
--
-- Rule: drop an INSERT silently when an identical service line already exists
-- on the same ticket with queue_entry_id IS NULL. "Identical" = same name +
-- staff1_id + staff2_id + unit_price. Rows with a non-NULL qid are already
-- protected by the partial unique index `uniq_ticket_items_per_entry` and by
-- the in-batch #N disambiguation in appendItemsToTicket.
--
-- Legitimate "two of the same service for one client" is still possible via
-- quantity (the bucket recompute / catalog add already supports it) or by
-- assigning the second instance to a different staff.

CREATE OR REPLACE FUNCTION silently_skip_ticket_items_duplicate_null_qid()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.queue_entry_id IS NULL AND NEW.kind = 'service' THEN
    IF EXISTS (
      SELECT 1 FROM ticket_items
      WHERE ticket_id = NEW.ticket_id
        AND queue_entry_id IS NULL
        AND kind = 'service'
        AND name = NEW.name
        AND COALESCE(staff1_id, '') = COALESCE(NEW.staff1_id, '')
        AND COALESCE(staff2_id, '') = COALESCE(NEW.staff2_id, '')
        AND unit_price_cents = NEW.unit_price_cents
    ) THEN
      RAISE NOTICE 'silently_skip_ticket_items_duplicate_null_qid: dropping ticket_id=% name=% staff1=%',
        NEW.ticket_id, NEW.name, NEW.staff1_id;
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_items_skip_duplicate_null_qid ON ticket_items;
CREATE TRIGGER ticket_items_skip_duplicate_null_qid
BEFORE INSERT ON ticket_items
FOR EACH ROW EXECUTE FUNCTION silently_skip_ticket_items_duplicate_null_qid();
