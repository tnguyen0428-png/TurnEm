-- Make manicurists.total_turns DERIVED from completed_services so the counter
-- can never drift from the underlying work.
--
-- Why this exists
-- ===============
-- `total_turns` had been maintained as an independent counter incremented/
-- decremented by several client paths:
--   - reducer COMPLETE_SERVICE: +turn_value
--   - reducer CANCEL_SERVICE:   -turn_value
--   - TicketModal.doSave bucket recompute: ±delta on staff swap / service edit
--   - TicketModal.doSave new-staff add-line credit: +turn_value
--   - voidTicket rollback: -turn_value for every completed_services row on the
--     voided visit
--
-- Each path was correct in isolation but the matrix of "add-then-edit",
-- "add-then-remove", and "remove-then-readd" interactions left drift behind.
-- On 2026-05-22, Kayla's card showed 8 turns; her completed_services rows
-- summed to 5; her ACTUAL work was ~3.5 turns. The +3 between
-- completed_services and the card is exactly the kind of drift this trigger
-- ends permanently.
--
-- The fix: treat completed_services as the single source of truth for turns.
-- Any insert / update / delete on a completed_services row triggers a
-- recompute of manicurists.total_turns for the affected manicurist(s) as
-- `SUM(turn_value) WHERE manicurist_id = X AND voided IS NOT TRUE`.
--
-- After this migration, drift is physically impossible: even if a future
-- client bug writes a wrong value to manicurists.total_turns directly, the
-- next completed_services change for that manicurist re-derives the correct
-- value from the row data. The trigger respects whatever turn_value is on
-- each completed_services row, so individual rows can still be wrong (e.g.
-- inflated services arrays); but the SUM relationship between rows and
-- counter is invariant.

CREATE OR REPLACE FUNCTION public.sync_manicurist_total_turns_from_completed()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  affected_ids text[] := '{}'::text[];
BEGIN
  -- Collect every manicurist_id touched by this row change. For an UPDATE
  -- that swaps manicurist_id from A to B, BOTH A and B need recomputing.
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.manicurist_id IS NOT NULL THEN
    affected_ids := array_append(affected_ids, NEW.manicurist_id);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.manicurist_id IS NOT NULL THEN
    IF NOT (OLD.manicurist_id = ANY(affected_ids)) THEN
      affected_ids := array_append(affected_ids, OLD.manicurist_id);
    END IF;
  END IF;

  IF array_length(affected_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Recompute total_turns for each affected manicurist. Voided rows are
  -- excluded — same rule the voidTicket rollback path used.
  UPDATE public.manicurists m
  SET total_turns = COALESCE((
    SELECT SUM(cs.turn_value)
    FROM public.completed_services cs
    WHERE cs.manicurist_id = m.id
      AND cs.voided IS NOT TRUE
  ), 0)
  WHERE m.id = ANY(affected_ids);

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS manicurist_turns_sync_on_completed_change
  ON public.completed_services;
CREATE TRIGGER manicurist_turns_sync_on_completed_change
  AFTER INSERT OR UPDATE OR DELETE ON public.completed_services
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_manicurist_total_turns_from_completed();

-- One-time alignment: bring every manicurist's current total_turns into
-- agreement with their completed_services rows RIGHT NOW. After this UPDATE
-- runs, the trigger keeps them in lockstep forever.
--
-- Kayla (082bac58-fa58-41dd-87ca-094ee095836b) snaps from 8 → 5 here.
-- Any other staff who silently drifted from today's testing also snaps to
-- their correct sum.
UPDATE public.manicurists m
SET total_turns = COALESCE((
  SELECT SUM(cs.turn_value)
  FROM public.completed_services cs
  WHERE cs.manicurist_id = m.id
    AND cs.voided IS NOT TRUE
), 0);
