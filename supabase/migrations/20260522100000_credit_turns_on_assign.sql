-- Credit a manicurist's turn the MOMENT a client is assigned to them
-- (in the queue OR via the open ticket modal's add-line flow), and refund
-- it the moment that assignment is changed or removed.
--
-- Architecture
-- ============
-- completed_services is the single source of truth for turn credit. The
-- existing total_turns trigger (migration 20260522090000) keeps
-- manicurists.total_turns = SUM(turn_value WHERE NOT voided) for every
-- manicurist. So all we need is to make sure completed_services has a row
-- the moment work is assigned — and that row gets edited/removed as the
-- assignment changes.
--
-- "In progress" rows have completed_at IS NULL. "Finished" rows have
-- completed_at set (the existing COMPLETE_SERVICE handler in the reducer
-- continues to set it when the manicurist hits DONE — the ON CONFLICT
-- clause below preserves completed_at if it's already set, so a queue-side
-- edit on already-completed work doesn't accidentally un-complete it).
--
-- Two new triggers:
--   1. queue_entries_credit_turns_on_assign
--      Fires when a queue_entries row changes. Upserts an in-progress
--      completed_services row keyed by queue_entries.id; deletes it when
--      the assignment goes away. Uses queue_entries.turn_value directly
--      (the client reducer already maintains it via catalog + request
--      half-credit logic), so we don't re-derive in PL/pgSQL.
--
--   2. ticket_items_propagate_to_queue
--      Fires when staff1_id changes on a service ticket_item, or when a
--      service ticket_item is deleted. Propagates the change back to the
--      corresponding queue_entry — which re-fires trigger #1, which
--      updates completed_services, which re-fires the existing total_turns
--      trigger. One canonical pipeline: queue → completed → counter.

-- ─── Trigger 1: queue_entries → in-progress completed_services ──────────────
CREATE OR REPLACE FUNCTION public.sync_in_progress_completed_from_queue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_mani_name text;
  v_mani_color text;
  v_should_have_row boolean;
BEGIN
  v_should_have_row := (TG_OP IN ('INSERT', 'UPDATE'))
    AND NEW.assigned_manicurist_id IS NOT NULL
    AND COALESCE(NEW.status, '') NOT IN ('completed', 'voided', 'cancelled');

  IF v_should_have_row THEN
    SELECT name, color INTO v_mani_name, v_mani_color
      FROM public.manicurists WHERE id = NEW.assigned_manicurist_id LIMIT 1;

    INSERT INTO public.completed_services (
      id, client_name,
      manicurist_id, manicurist_name, manicurist_color,
      service, services, requested_services, turn_value,
      is_appointment, is_requested, edited, voided,
      started_at, completed_at
    ) VALUES (
      NEW.id, COALESCE(NEW.client_name, 'Walk-in'),
      NEW.assigned_manicurist_id,
      COALESCE(v_mani_name, ''), COALESCE(v_mani_color, '#9ca3af'),
      COALESCE(NEW.services[1], ''),
      COALESCE(NEW.services, '{}'::text[]),
      '{}'::text[],
      COALESCE(NEW.turn_value, 0),
      COALESCE(NEW.is_appointment, false),
      COALESCE(NEW.is_requested, false),
      false, false,
      COALESCE(NEW.started_at, NEW.arrived_at, NOW()),
      NULL  -- in-progress marker
    )
    ON CONFLICT (id) DO UPDATE SET
      client_name        = EXCLUDED.client_name,
      manicurist_id      = EXCLUDED.manicurist_id,
      manicurist_name    = EXCLUDED.manicurist_name,
      manicurist_color   = EXCLUDED.manicurist_color,
      service            = EXCLUDED.service,
      services           = EXCLUDED.services,
      turn_value         = EXCLUDED.turn_value,
      is_appointment     = EXCLUDED.is_appointment,
      is_requested       = EXCLUDED.is_requested
      -- DELIBERATELY do NOT overwrite completed_at, edited, voided.
      -- Completed work stays completed even if queue_entry gets touched.
      ;
  ELSIF TG_OP IN ('UPDATE', 'DELETE') AND OLD.id IS NOT NULL THEN
    -- Queue entry no longer holds an active assignment. Drop the
    -- in-progress row. NEVER touch a row whose completed_at is set —
    -- that's finished work and shouldn't be refunded by a queue edit.
    DELETE FROM public.completed_services
    WHERE id = OLD.id
      AND completed_at IS NULL;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS queue_entries_credit_turns_on_assign ON public.queue_entries;
CREATE TRIGGER queue_entries_credit_turns_on_assign
  AFTER INSERT OR UPDATE OR DELETE ON public.queue_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_in_progress_completed_from_queue();

-- ─── Trigger 2: ticket_items → propagate to queue_entries ───────────────────
--
-- Cashier edits the open ticket modal:
--   - Staff change on existing line → propagate to queue_entries so the
--     turn moves to the new manicurist.
--   - Service line deleted → remove the matching service from the
--     queue_entry's services array; if that empties the queue_entry,
--     delete the queue_entry. Both paths refund the turn via trigger 1.

CREATE OR REPLACE FUNCTION public.propagate_ticket_item_to_queue_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_qe_prefix text;
  v_qe_services text[];
  v_new_services text[];
  v_idx int;
  v_removed boolean := false;
BEGIN
  v_qe_prefix := COALESCE(NEW.queue_entry_id, OLD.queue_entry_id, '');
  IF v_qe_prefix = '' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF position('#' IN v_qe_prefix) > 0 THEN
    v_qe_prefix := split_part(v_qe_prefix, '#', 1);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.kind = 'service' THEN
    IF NEW.staff1_id IS DISTINCT FROM OLD.staff1_id AND NEW.staff1_id IS NOT NULL THEN
      UPDATE public.queue_entries
        SET assigned_manicurist_id = NEW.staff1_id
        WHERE id = v_qe_prefix
          AND assigned_manicurist_id IS DISTINCT FROM NEW.staff1_id;
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.kind = 'service' THEN
    SELECT services INTO v_qe_services
      FROM public.queue_entries WHERE id = v_qe_prefix;
    IF v_qe_services IS NULL THEN RETURN OLD; END IF;

    -- Remove the FIRST matching occurrence of the deleted service name.
    -- Two services with the same name on one queue_entry only lose one
    -- entry per ticket_item delete — that's the right invariant.
    v_new_services := '{}'::text[];
    FOR v_idx IN 1..COALESCE(array_length(v_qe_services, 1), 0) LOOP
      IF NOT v_removed AND v_qe_services[v_idx] = OLD.name THEN
        v_removed := true;
        CONTINUE;
      END IF;
      v_new_services := array_append(v_new_services, v_qe_services[v_idx]);
    END LOOP;

    IF array_length(v_new_services, 1) IS NULL OR array_length(v_new_services, 1) = 0 THEN
      DELETE FROM public.queue_entries WHERE id = v_qe_prefix;
    ELSE
      UPDATE public.queue_entries
        SET services = v_new_services
        WHERE id = v_qe_prefix;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS ticket_items_propagate_to_queue ON public.ticket_items;
CREATE TRIGGER ticket_items_propagate_to_queue
  AFTER UPDATE OR DELETE ON public.ticket_items
  FOR EACH ROW
  EXECUTE FUNCTION public.propagate_ticket_item_to_queue_entry();

-- ─── One-time backfill ──────────────────────────────────────────────────────
--
-- Any queue_entries currently assigned but without an in-progress
-- completed_services row get one. The total_turns trigger then snaps the
-- manicurist cards to reflect the new credits.
INSERT INTO public.completed_services (
  id, client_name,
  manicurist_id, manicurist_name, manicurist_color,
  service, services, requested_services, turn_value,
  is_appointment, is_requested, edited, voided,
  started_at, completed_at
)
SELECT
  q.id,
  COALESCE(q.client_name, 'Walk-in'),
  q.assigned_manicurist_id,
  COALESCE(m.name, ''), COALESCE(m.color, '#9ca3af'),
  COALESCE(q.services[1], ''),
  COALESCE(q.services, '{}'::text[]),
  '{}'::text[],
  COALESCE(q.turn_value, 0),
  COALESCE(q.is_appointment, false),
  COALESCE(q.is_requested, false),
  false, false,
  COALESCE(q.started_at, q.arrived_at, NOW()),
  NULL
FROM public.queue_entries q
LEFT JOIN public.manicurists m ON m.id = q.assigned_manicurist_id
WHERE q.assigned_manicurist_id IS NOT NULL
  AND COALESCE(q.status, '') NOT IN ('completed', 'voided', 'cancelled')
ON CONFLICT (id) DO NOTHING;
