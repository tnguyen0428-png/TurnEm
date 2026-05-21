-- Re-scope silently_skip_ticket_items_on_closed_ticket so it only blocks
-- trigger-cascaded inserts, not direct client inserts.
--
-- Background: the earlier migration `20260521230000_skip_ticket_items_on_closed`
-- added a BEFORE INSERT trigger that silently drops any insert whose parent
-- ticket isn't 'open'. That was meant to plug a race in
-- `tickets_ensure_for_visit`: a queue_entries-driven cascaded insert can fire
-- with a stale snapshot showing the ticket as 'open' even though the close
-- has just committed, leaving a stray late line on a closed ticket.
--
-- Side effect we hit on 2026-05-21: the receptionist EDIT flow on a CLOSED
-- ticket goes through `updateOpenTicket`, which DELETEs every ticket_item
-- for the ticket and then re-INSERTs the edited set. Those direct
-- client INSERTs were being silently dropped, leaving tickets #22 (Rosie /
-- PANDA, $38) and #34 (Kim / TAMMY, $20) with zero ticket_items but intact
-- payments after a cashier edit.
--
-- Fix: gate the skip on `pg_trigger_depth() > 0` so only trigger-cascaded
-- inserts (the actual race target) are constrained. Direct client inserts
-- pass through regardless of parent status — the receptionist explicitly
-- unlocked the closed ticket via the PIN gate, so writes from that flow
-- should land.

CREATE OR REPLACE FUNCTION public.silently_skip_ticket_items_on_closed_ticket()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_status text;
BEGIN
  -- Direct client inserts (no enclosing trigger) are always allowed so the
  -- closed-ticket EDIT save path isn't silently dropped.
  IF pg_trigger_depth() = 0 THEN
    RETURN NEW;
  END IF;

  -- Lock the parent ticket row for the duration of this trigger so a
  -- concurrent UPDATE on tickets.status that's about to commit will be
  -- serialized against this insert. After the lock is acquired we read the
  -- current committed status.
  SELECT status INTO parent_status
    FROM tickets
   WHERE id = NEW.ticket_id
     FOR SHARE;

  -- Parent doesn't exist yet — let the FK constraint handle it the usual way.
  IF parent_status IS NULL THEN
    RETURN NEW;
  END IF;

  -- For cascaded inserts only: 'open' is the only state where new lines may
  -- be appended. For closed and voided tickets we silently drop the insert
  -- (returning NULL from a BEFORE trigger skips the row).
  IF parent_status <> 'open' THEN
    RAISE NOTICE 'silently_skip_ticket_items_on_closed_ticket: ticket % is % (trigger-cascaded) - skipping insert of %', NEW.ticket_id, parent_status, NEW.name;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;
