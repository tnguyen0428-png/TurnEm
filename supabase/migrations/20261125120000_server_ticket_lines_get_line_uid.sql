-- Fix: ticket lines saved with line_uid = NULL (see FIX_LINE_UID_NULL_2026-10-24.md)
--
-- ROOT CAUSE (found 2026-11-25): the DB function tickets_ensure_for_visit (run by
-- the tickets_on_queue_change / tickets_on_completed_* triggers) creates almost
-- every service line FIRST, without a line_uid. The app then finds that row and
-- only UPDATEs it (rewrites queue_entry_id), so line_uid stays NULL forever.
-- On 2026-11-24, 72 of 74 tickets went through this path; 101/108 lines NULL.
--
-- APPLIED to production 2026-11-25 7:42am PT (steps 1-3, via Supabase MCP;
-- recorded as migration "server_ticket_lines_get_line_uid"). Dry run in a
-- rolled-back transaction confirmed #svc0/#svc1 lines get q:<visit>:mani-N:0/1.
-- Safe to run more than once.

-- 1. SQL twin of lineUidForQid() in src/lib/tickets.ts. MUST stay in lockstep.
--    (Tested against the JS version on 10 real qid shapes - all identical.)
CREATE OR REPLACE FUNCTION public.ticket_line_uid_for_qid(p_qid text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  v_root text;
  v_mani text;
  v_slot text;
BEGIN
  IF p_qid IS NOT NULL AND position('-add-' in p_qid) = 0 THEN
    v_root := substring(p_qid from '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
    IF v_root IS NOT NULL AND v_root <> p_qid THEN
      v_mani := coalesce(substring(p_qid from '.*(mani-[0-9]+)'), '_');
      v_slot := coalesce(substring(p_qid from '.*#(?:svc)?([0-9]+)'), '0');
      RETURN 'q:' || v_root || ':' || v_mani || ':' || v_slot;
    END IF;
  END IF;
  RETURN 'u:' || gen_random_uuid()::text;
END;
$fn$;

-- 2. Patch tickets_ensure_for_visit in place: stamp each line with the SAME
--    line_uid the app would compute (entry.id / entry.id#svc<idx>), and skip on
--    ANY unique conflict instead of erroring. Aborts if the function text has
--    changed (each pattern must match exactly once). No-op if already patched.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.tickets_ensure_for_visit'::regproc);
  v_a_old text := E'        queue_entry_id\n      ) VALUES (';
  v_a_new text := E'        queue_entry_id, line_uid\n      ) VALUES (';
  v_b_old text := E'        v_line_qe\n      )\n      ON CONFLICT (ticket_id, queue_entry_id) WHERE queue_entry_id IS NOT NULL\n      DO NOTHING;';
  v_b_new text := E'        v_line_qe,\n        -- Same line_uid the app computes for this line (lineUidForQid on\n        -- entry.id / entry.id#svc<idx>), so the app''s write of the same line collapses.\n        public.ticket_line_uid_for_qid(\n          CASE WHEN coalesce(array_length(p_services, 1), 0) > 1\n               THEN p_source_row_id || ''#svc'' || (v_line_idx - 1)\n               ELSE p_source_row_id END)\n      )\n      -- No conflict target: skip on ANY unique hit (ticket_id+queue_entry_id OR line_uid)\n      -- instead of raising and aborting the queue update.\n      ON CONFLICT DO NOTHING;';
BEGIN
  IF position('ticket_line_uid_for_qid' in v_def) > 0 THEN
    RAISE NOTICE 'tickets_ensure_for_visit already patched - skipping';
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a_old, ''))) / length(v_a_old) <> 1 THEN
    RAISE EXCEPTION 'pattern A not found exactly once - function changed, stop';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_b_old, ''))) / length(v_b_old) <> 1 THEN
    RAISE EXCEPTION 'pattern B not found exactly once - function changed, stop';
  END IF;
  EXECUTE replace(replace(v_def, v_a_old, v_a_new), v_b_old, v_b_new);
END
$do$;

-- 3. Safety net: any other inserter (reconcile_dropped_ticket_lines,
--    reprice_completed_services_for_visit, future code) that leaves line_uid
--    NULL gets a unique random u: id. Random, so it can never collide or error.
CREATE OR REPLACE FUNCTION public.ticket_items_fill_line_uid()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.line_uid IS NULL THEN
    NEW.line_uid := 'u:' || gen_random_uuid()::text;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ticket_items_zz_fill_line_uid ON public.ticket_items;
CREATE TRIGGER ticket_items_zz_fill_line_uid
  BEFORE INSERT ON public.ticket_items
  FOR EACH ROW EXECUTE FUNCTION public.ticket_items_fill_line_uid();

-- 4. Verify (should return: true | 1)
SELECT position('ticket_line_uid_for_qid' in prosrc) > 0 AS fn_patched,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'ticket_items_zz_fill_line_uid') AS trigger_exists
FROM pg_proc WHERE proname = 'tickets_ensure_for_visit';

-- ROLLBACK (only if something goes wrong):
--   DROP TRIGGER IF EXISTS ticket_items_zz_fill_line_uid ON public.ticket_items;
--   then re-run the DO block above with the _old/_new strings swapped.
