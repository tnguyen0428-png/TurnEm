-- Narrow escape hatch for guard_completed_services_delete (2026-06-09):
-- that trigger blocks any DELETE on a completed_services row completed in
-- the last 7 days unless app.allow_clear='on', which was previously only
-- ever set inside admin_clear_day() (the whole-day-wipe admin function).
--
-- voidTicket()'s per-visit completed_services cleanup was never wired up to
-- that escape hatch, so every void of a ticket completed in the last 7 days
-- was silently failing to delete its completed_services rows — they stayed
-- behind marked voided=true instead of being removed, and the app's
-- load-time half-applied-void reconciliation kept retrying (and re-failing)
-- the same delete on every page load (Lisa Kiel, 2026-08-06).
--
-- This function only deletes rows for a visit whose ticket is ALREADY
-- marked 'voided' in the tickets table, so it can't be used to delete live
-- (non-voided) completed work even if invoked directly — unlike
-- admin_clear_day, which wipes everything and needs a passcode, this is
-- scoped to one already-authorized visit at a time and needs none.
CREATE OR REPLACE FUNCTION public.void_completed_services_for_visit(p_visit_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tickets
    WHERE queue_entry_id = p_visit_id AND status = 'voided'
  ) THEN
    RAISE EXCEPTION 'No voided ticket found for visit %', p_visit_id;
  END IF;

  PERFORM set_config('app.allow_clear', 'on', true);
  WITH del AS (
    DELETE FROM completed_services
    WHERE id = p_visit_id OR id LIKE p_visit_id || '-%'
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM del;

  RETURN v_count;
END;
$function$;
