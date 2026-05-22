-- Silently drop any ticket_items INSERT whose queue_entry_id contains '-add-'.
--
-- Why this exists
-- ===============
-- The cashier's "+ Add line" flow in TicketModal constructs a synthetic queue
-- entry with id '${visitId}-add-${staffId}' so the manicurist card flips to
-- BUSY immediately (see TicketModal.ensureManicuristBusyForAddedLine). That id
-- must NEVER land on a ticket_items row — TicketModal.updateOpenTicket owns
-- the ticket_items lifecycle for those add-lines via the bare visit-id
-- fallback in buildItemsForSave.
--
-- We already short-circuit the queue->ticket trigger
-- (`tickets_ensure_for_visit`) for source rows that look like add-children
-- (migration 20260522050000), and we filter client-side in:
--   - appendItemsToTicket          (src/lib/tickets.ts ~line 1012)
--   - syncEntryToTicket            (src/lib/tickets.ts ~line 1283)
--   - updateOpenTicket             (src/lib/tickets.ts ~line 1820, added in
--                                   this same change)
--
-- But on 2026-05-22 we hit ticket #2's phantom Row 2: a ticket_items row with
-- qid '{visit}-add-{staff}' and no '#N' suffix. The qid format rules out the
-- DB trigger (which always appends '#${v_line_idx}') and points at a client
-- insert, but every known client path is now guarded. Rather than chase the
-- mystery inserter through the source one more time, we install a hard
-- BEFORE INSERT guard at the DB layer. Any path — current, future, or
-- previously-undiscovered — that tries to write a '-add-' qid is silently
-- dropped before the row lands.
--
-- Mirrors the design of `silently_skip_ticket_items_on_closed_ticket` (added
-- in migration 20260521230000): silent (returns NULL) rather than RAISE-ing,
-- because the row drop should be invisible to the calling client and not
-- error the transaction. We RAISE NOTICE so the offender shows up in
-- pg_log / Supabase logs if we ever need to diagnose another phantom report.
--
-- This trigger sits ALONGSIDE the existing closed-ticket trigger; both run
-- BEFORE INSERT on ticket_items. Either one returning NULL skips the row.

CREATE OR REPLACE FUNCTION public.silently_skip_ticket_items_with_add_child_qid()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only act on rows with a queue_entry_id we know is the add-child marker.
  -- NULL or non-matching qids are passed through untouched.
  IF NEW.queue_entry_id IS NOT NULL
     AND position('-add-' in NEW.queue_entry_id) > 0
  THEN
    RAISE NOTICE 'silently_skip_ticket_items_with_add_child_qid: dropping ticket_items insert for ticket % with qid % (name %)',
      NEW.ticket_id, NEW.queue_entry_id, NEW.name;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ticket_items_skip_add_child_qid ON public.ticket_items;
CREATE TRIGGER ticket_items_skip_add_child_qid
  BEFORE INSERT ON public.ticket_items
  FOR EACH ROW
  EXECUTE FUNCTION public.silently_skip_ticket_items_with_add_child_qid();

-- Cleanup pass: drop any pre-existing phantom rows from prior bugs, BUT
-- only on non-voided tickets. The existing `guard_ticket_items_on_voided_ticket`
-- BEFORE DELETE/UPDATE trigger raises on any modification to voided tickets'
-- items, which would roll back this entire migration. Phantom rows on voided
-- tickets don't affect billing (the ticket is voided), so we leave them
-- in place. The trigger above prevents new phantom rows regardless.
--
-- Recompute subtotal/total on every ticket that lost a row so the header
-- totals reflect the corrected line set.
WITH deletable AS (
  SELECT ti.id
  FROM public.ticket_items ti
  JOIN public.tickets t ON t.id = ti.ticket_id
  WHERE ti.queue_entry_id IS NOT NULL
    AND position('-add-' in ti.queue_entry_id) > 0
    AND t.status <> 'voided'
),
deleted AS (
  DELETE FROM public.ticket_items
  WHERE id IN (SELECT id FROM deletable)
  RETURNING ticket_id
),
affected AS (
  SELECT DISTINCT ticket_id FROM deleted
),
new_subtotal AS (
  SELECT
    a.ticket_id,
    COALESCE(
      SUM(GREATEST(0, ti.unit_price_cents * ti.quantity - ti.discount_cents))::int,
      0
    ) AS subtotal_cents
  FROM affected a
  LEFT JOIN public.ticket_items ti ON ti.ticket_id = a.ticket_id
  GROUP BY a.ticket_id
)
UPDATE public.tickets t
SET
  subtotal_cents = ns.subtotal_cents,
  total_cents    = GREATEST(0,
      ns.subtotal_cents
    - COALESCE(t.discount_cents, 0)
    + COALESCE(t.tax_cents, 0)
    + COALESCE(t.tip_cents, 0)
  ),
  updated_at     = NOW()
FROM new_subtotal ns
WHERE t.id = ns.ticket_id;
