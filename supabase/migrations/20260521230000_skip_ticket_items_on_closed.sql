-- Stop ticket_items from being inserted into a ticket that's already closed.
--
-- Symptom that motivated this migration: ticket #9 on 2026-05-21 (Anette Gahris)
-- ended up with a third "Gel Full Set / TOMMY" line item inserted 175 ms AFTER
-- the ticket was closed. The trigger `tickets_ensure_for_visit` reads the
-- ticket status at the top of its function body and exits early if status is
-- not 'open' — but under concurrent updates, a transaction whose snapshot
-- predates the close commit will read 'open' and still INSERT.
--
-- The existing `guard_ticket_items_on_voided_ticket` BEFORE trigger only
-- covers VOIDED tickets and RAISES (rejects). The function
-- `reject_ticket_items_on_closed_ticket` exists in the codebase but was never
-- wired up as a trigger.
--
-- Hard-rejecting CLOSED inserts is risky because the cashier flow legitimately
-- inserts items right up to the moment of close — we don't want concurrent
-- syncs to ERROR. So we use a BEFORE INSERT trigger that SILENTLY skips
-- (returns NULL) when the parent ticket is no longer open. A FOR SHARE row
-- lock on the parent ticket eliminates the snapshot race.

CREATE OR REPLACE FUNCTION public.silently_skip_ticket_items_on_closed_ticket()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_status text;
BEGIN
  -- Lock the parent ticket row for the duration of this trigger so that a
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

  -- 'open' is the only state where new lines may be appended. For closed and
  -- voided tickets we silently drop the insert (returning NULL from a BEFORE
  -- trigger skips the row). This is intentionally NON-noisy because the
  -- common case is a trigger fire racing with the close — we don't want
  -- those races to ERROR the calling client transaction.
  IF parent_status <> 'open' THEN
    RAISE NOTICE 'silently_skip_ticket_items_on_closed_ticket: ticket % is % — skipping insert of %', NEW.ticket_id, parent_status, NEW.name;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ticket_items_skip_on_closed ON public.ticket_items;
CREATE TRIGGER ticket_items_skip_on_closed
  BEFORE INSERT ON public.ticket_items
  FOR EACH ROW
  EXECUTE FUNCTION public.silently_skip_ticket_items_on_closed_ticket();
