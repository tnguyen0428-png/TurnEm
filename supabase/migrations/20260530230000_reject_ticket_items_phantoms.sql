-- Two new BEFORE INSERT guards on ticket_items, closing the path that
-- produced the 2026-05-30 phantom on ticket #89 (Kathy, DANNY Gel Pedicure).
--
-- The phantom signature this time:
--   * Legit row : qid `<visit>-mani-18#svc1`  inserted 22:34:00.516  (4s before close)
--   * Phantom   : qid `<visit>`               inserted 22:34:35.527  (235ms AFTER close)
--   * Parent ticket.status='closed' at 22:34:35.292
--   * Customer paid $150 against $200 subtotal — phantom inflated subtotal
--
-- Why the existing defenses didn't fire
-- =====================================
-- 1. `silently_skip_ticket_items_with_add_child_qid` (mig 20260522080000)
--    only drops rows whose qid contains `-add-`. Phantom qid was bare.
-- 2. `silently_skip_ticket_items_duplicate_null_qid` (mig 20260529180000)
--    only fires when NEW.queue_entry_id IS NULL. Phantom qid was non-null.
-- 3. `silently_skip_ticket_items_on_closed_ticket` (mig 20260521230000)
--    is gated to trigger-cascaded inserts (`pg_trigger_depth() > 0`).
--    The phantom was a direct client insert, so depth=0, gate didn't trip.
--
-- New guards
-- ==========
-- A. `reject_ticket_items_on_closed_ticket_unconditional` — fires for
--    EVERY insert (no pg_trigger_depth gate) when parent ticket is closed
--    or voided. Same silent-drop pattern as the rest of the family.
--    Catches any code path that races the checkout flow.
--
-- B. `reject_ticket_items_duplicate_composite_key` — extends the NULL-qid
--    dedupe to ALL inserts: if a non-voided row with the same
--    (ticket_id, kind, name, staff1_id, staff2_id, unit_price_cents)
--    already exists on the ticket, drop the new one regardless of its
--    qid. Legitimate "two of the same service for one client" is still
--    supported via the quantity column, or via a different staff
--    assignment.
--
-- Both run BEFORE INSERT FOR EACH ROW and return NULL on rejection (silent
-- drop, no error returned to the client) with RAISE NOTICE so the
-- offender shows up in Supabase logs for diagnosis.

-- ---------------------------------------------------------------------------
-- Guard A: reject inserts on closed/voided tickets, unconditionally
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_ticket_items_on_closed_ticket_unconditional()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM tickets
  WHERE id = NEW.ticket_id;

  IF parent_status IN ('closed', 'voided') THEN
    RAISE NOTICE 'reject_ticket_items_on_closed_ticket_unconditional: dropping ticket_id=% status=% name=% staff1=% qid=%',
      NEW.ticket_id, parent_status, NEW.name, NEW.staff1_id, NEW.queue_entry_id;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_items_reject_on_closed_unconditional ON public.ticket_items;
CREATE TRIGGER ticket_items_reject_on_closed_unconditional
BEFORE INSERT ON public.ticket_items
FOR EACH ROW
EXECUTE FUNCTION public.reject_ticket_items_on_closed_ticket_unconditional();

-- ---------------------------------------------------------------------------
-- Guard B: composite-key dedupe (extends null-qid dedupe to ALL qids)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_ticket_items_duplicate_composite_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'service' THEN
    IF EXISTS (
      SELECT 1 FROM ticket_items
      WHERE ticket_id = NEW.ticket_id
        AND kind = 'service'
        AND name = NEW.name
        AND COALESCE(staff1_id, '') = COALESCE(NEW.staff1_id, '')
        AND COALESCE(staff2_id, '') = COALESCE(NEW.staff2_id, '')
        AND unit_price_cents = NEW.unit_price_cents
    ) THEN
      RAISE NOTICE 'reject_ticket_items_duplicate_composite_key: dropping ticket_id=% name=% staff1=% price=% existing_qid_pattern_conflict_with_new_qid=%',
        NEW.ticket_id, NEW.name, NEW.staff1_id, NEW.unit_price_cents, NEW.queue_entry_id;
      RETURN NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_items_reject_duplicate_composite_key ON public.ticket_items;
CREATE TRIGGER ticket_items_reject_duplicate_composite_key
BEFORE INSERT ON public.ticket_items
FOR EACH ROW
EXECUTE FUNCTION public.reject_ticket_items_duplicate_composite_key();
