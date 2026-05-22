-- =========================================================================
-- TurnEm — Apply pending ticket-fix migrations (paste-and-run)
-- =========================================================================
-- Combines three local migration files that exist in supabase/migrations/
-- but were never applied to the live Supabase database:
--
--   1. 20260520134828_ticket_trigger_per_service_tombstone
--      Per-(source_row, service) tombstone so cashier deletes stay deleted.
--   2. 20260521230000_skip_ticket_items_on_closed
--      Plus its 20260521230500 follow-up that scopes the guard to
--      trigger-cascaded inserts only.
--      Already committed locally — included here for completeness so you can
--      verify the trigger exists.
--   3. 20260521233000_drop_completed_services_update_propagation
--      Drops the trg_tickets_on_completed_update trigger entirely. This is
--      what stops phantom lines from popping up every time TicketModal saves.
--
-- Run this in the Supabase SQL editor. It's idempotent (all CREATE OR REPLACE
-- / DROP IF EXISTS / IF NOT EXISTS), so re-running is safe.
-- =========================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- 1. Per-service tombstone (20260520134828)
-- ─────────────────────────────────────────────────────────
-- Per-(source_row_id, service_name) tombstone for the queue/completed -> ticket
-- auto-attribution trigger.
--
-- Background:
--   On 2026-05-15 we removed the source_row_id re-fire guard from
--   tickets_ensure_for_visit so that mid-visit service additions
--   (queue_entries.services growing) would land on the open ticket.
--   The only remaining safety was the per-service "same name + staff
--   already on the ticket?" check inside the service loop.
--
--   That left no memory of cashier deletions. If the cashier deleted a
--   ticket_item via TicketModal, the very next trigger fire (an
--   unrelated UPDATE on queue_entries or completed_services for the
--   same visit) saw the line missing from ticket_items and inserted it
--   right back. Symptom: "deleted lines do not stay deleted" and, by
--   extension, "additional services aren't continuously sticking" when
--   the cashier and the trigger fight over the same line.
--
-- Fix:
--   auto_attributed_sources now stores per-line tombstone tuples in
--   the form `${source_row_id}::${service_name}` in addition to the
--   bare source_row_id stamps recorded by the previous version.
--
--   The trigger checks the tuple BEFORE the same-name-staff guard:
--     - tuple already attributed -> SKIP (no matter whether the line
--       currently exists on the ticket).
--     - tuple not seen yet      -> proceed to same-name-staff guard,
--       insert if absent, and record the tuple regardless of whether
--       the actual INSERT happened (so a same-name-staff dedupe also
--       contributes a tombstone).
--
--   Genuinely-new services from the same source row produce a fresh
--   tuple and still get inserted -- the May 15 mid-visit-addition
--   behavior is preserved.
--
-- Backfill:
--   For every OPEN ticket we add the tuples derived from the lines
--   currently on the ticket, so existing in-flight tickets are
--   immediately protected against the next trigger re-fire.
--   Closed/voided tickets are skipped (trigger already short-circuits).

CREATE OR REPLACE FUNCTION public.tickets_ensure_for_visit(
  p_visit_id text,
  p_business_date date,
  p_client_name text,
  p_manicurist_id text,
  p_opened_at timestamp with time zone,
  p_services text[],
  p_source_row_id text
)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ticket_id uuid;
  v_ticket_status text;
  v_attributed text[];
  v_pname text;
  v_pcolor text;
  v_next_num int;
  v_svc_id text;
  v_svc_price numeric;
  v_svc_name text;
  v_sort_max int;
  v_subtotal int;
  v_staff_name text;
  v_staff_color text;
  v_line_idx int := 0;
  v_line_qe text;
  v_tuple text;
  v_new_tuples text[] := '{}'::text[];
BEGIN
  IF p_visit_id IS NULL OR p_visit_id = '' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_visit_id, 0));

  -- NORMALIZED lookup (preserved from prior definition): match by
  -- tickets_visit_id(queue_entry_id) rather than exact equality so
  -- tickets historically stored with a suffixed form (e.g.
  -- `<base>-waiting`) are still recognized as the ticket for this
  -- visit. Prefer OPEN over closed/voided; within open prefer most
  -- recent opened_at.
  SELECT id, status, auto_attributed_sources
    INTO v_ticket_id, v_ticket_status, v_attributed
  FROM tickets
  WHERE public.tickets_visit_id(queue_entry_id) = p_visit_id
  ORDER BY (status = 'open') DESC, opened_at DESC
  LIMIT 1;

  -- Never modify closed / voided tickets.
  IF v_ticket_id IS NOT NULL AND v_ticket_status <> 'open' THEN
    RETURN v_ticket_id;
  END IF;

  IF v_ticket_id IS NULL THEN
    SELECT name, color INTO v_pname, v_pcolor FROM manicurists WHERE id = p_manicurist_id;
    v_pname := COALESCE(v_pname, '');
    v_pcolor := COALESCE(v_pcolor, '#9ca3af');

    PERFORM pg_advisory_xact_lock(hashtextextended('tnum:' || p_business_date::text, 0));

    SELECT COALESCE(MAX(ticket_number), 0) + 1 INTO v_next_num
    FROM tickets WHERE business_date = p_business_date;

    INSERT INTO tickets (
      ticket_number, business_date, queue_entry_id, client_name,
      client_phone, client_email,
      primary_manicurist_id, primary_manicurist_name, primary_manicurist_color,
      subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, paid_cents,
      status, note, void_reason, opened_at, updated_at,
      auto_attributed_sources
    ) VALUES (
      v_next_num, p_business_date, p_visit_id,
      COALESCE(NULLIF(trim(p_client_name), ''), 'Walk-in'),
      '', '',
      p_manicurist_id, v_pname, v_pcolor,
      0, 0, 0, 0, 0, 0,
      'open', '', '', p_opened_at, NOW(),
      '{}'::text[]
    )
    ON CONFLICT (queue_entry_id) WHERE queue_entry_id IS NOT NULL
    DO UPDATE SET updated_at = NOW()
    RETURNING id INTO v_ticket_id;

    -- New ticket: no tombstones yet.
    v_attributed := '{}'::text[];
  ELSE
    IF p_manicurist_id IS NOT NULL THEN
      SELECT name, color INTO v_pname, v_pcolor FROM manicurists WHERE id = p_manicurist_id;
      UPDATE tickets SET
        primary_manicurist_id = p_manicurist_id,
        primary_manicurist_name = COALESCE(v_pname, ''),
        primary_manicurist_color = COALESCE(v_pcolor, '#9ca3af')
      WHERE id = v_ticket_id
        AND (primary_manicurist_id IS NULL OR primary_manicurist_id = '');
    END IF;
  END IF;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_sort_max FROM ticket_items WHERE ticket_id = v_ticket_id;

  SELECT name, color INTO v_staff_name, v_staff_color FROM manicurists WHERE id = p_manicurist_id;
  v_staff_name := COALESCE(v_staff_name, '');
  v_staff_color := COALESCE(v_staff_color, '#9ca3af');

  IF p_services IS NOT NULL THEN
    FOREACH v_svc_name IN ARRAY p_services LOOP
      v_line_idx := v_line_idx + 1;
      IF v_svc_name IS NULL OR trim(v_svc_name) = '' THEN CONTINUE; END IF;

      -- Per-(source_row, service) tombstone. If THIS source row has
      -- previously contributed THIS service to the ticket, never try
      -- again - the cashier may have deleted it intentionally and we
      -- have no business resurrecting it.
      v_tuple := COALESCE(p_source_row_id, '') || '::' || v_svc_name;
      IF v_tuple = ANY(COALESCE(v_attributed, '{}'::text[])) THEN
        CONTINUE;
      END IF;

      -- Same-name-staff guard: a line with this service+staff already
      -- on the ticket means we're racing with the client write path or
      -- a prior re-fire. Don't add a second line. Still record the
      -- tombstone so a future deletion is respected.
      IF EXISTS (
        SELECT 1 FROM ticket_items
        WHERE ticket_id = v_ticket_id
          AND name = v_svc_name
          AND staff1_id IS NOT DISTINCT FROM p_manicurist_id
      ) THEN
        v_new_tuples := array_append(v_new_tuples, v_tuple);
        CONTINUE;
      END IF;

      SELECT id, price INTO v_svc_id, v_svc_price FROM salon_services WHERE name = v_svc_name LIMIT 1;
      v_sort_max := v_sort_max + 1;
      v_line_qe := p_source_row_id || '#' || v_line_idx;

      INSERT INTO ticket_items (
        ticket_id, kind, name, service_id,
        staff1_id, staff1_name, staff1_color,
        staff2_id, staff2_name, staff2_color,
        unit_price_cents, quantity, discount_cents, ext_price_cents, sort_order,
        queue_entry_id
      ) VALUES (
        v_ticket_id, 'service', v_svc_name, v_svc_id,
        p_manicurist_id, v_staff_name, v_staff_color,
        NULL, '', '',
        COALESCE(ROUND(v_svc_price * 100)::int, 0), 1, 0,
        COALESCE(ROUND(v_svc_price * 100)::int, 0), v_sort_max,
        v_line_qe
      )
      ON CONFLICT (ticket_id, queue_entry_id) WHERE queue_entry_id IS NOT NULL
      DO NOTHING;

      v_new_tuples := array_append(v_new_tuples, v_tuple);
    END LOOP;
  END IF;

  -- Persist new tombstone tuples + bare source-row stamp (preserved
  -- for audit / back-compat; older code paths that read this array
  -- still see something familiar).
  IF v_new_tuples IS NOT NULL AND array_length(v_new_tuples, 1) > 0 THEN
    UPDATE tickets
    SET auto_attributed_sources = (
      SELECT ARRAY(
        SELECT DISTINCT x
        FROM unnest(COALESCE(auto_attributed_sources, '{}'::text[]) || v_new_tuples) AS x
      )
    )
    WHERE id = v_ticket_id;
  END IF;

  IF p_source_row_id IS NOT NULL AND p_source_row_id <> '' THEN
    UPDATE tickets
    SET auto_attributed_sources =
      CASE
        WHEN p_source_row_id = ANY(COALESCE(auto_attributed_sources, '{}'::text[]))
        THEN auto_attributed_sources
        ELSE array_append(COALESCE(auto_attributed_sources, '{}'::text[]), p_source_row_id)
      END
    WHERE id = v_ticket_id;
  END IF;

  SELECT COALESCE(SUM(ext_price_cents), 0)::int INTO v_subtotal
  FROM ticket_items WHERE ticket_id = v_ticket_id;

  UPDATE tickets SET
    subtotal_cents = v_subtotal,
    total_cents    = v_subtotal
                     - COALESCE(discount_cents, 0)
                     + COALESCE(tax_cents, 0)
                     + COALESCE(tip_cents, 0),
    updated_at     = NOW()
  WHERE id = v_ticket_id;

  RETURN v_ticket_id;
END;
$function$;

-- Backfill: for every OPEN ticket, fold tombstone tuples for each
-- existing service line into auto_attributed_sources. After this runs,
-- the next trigger fire respects the cashier's current ticket as the
-- source of truth and won't resurrect anything that ISN'T currently
-- on the ticket.
UPDATE tickets t
SET auto_attributed_sources = (
  SELECT ARRAY(
    SELECT DISTINCT x
    FROM unnest(
      COALESCE(t.auto_attributed_sources, '{}'::text[])
      || COALESCE(
        ARRAY(
          SELECT split_part(ti.queue_entry_id, '#', 1) || '::' || ti.name
          FROM ticket_items ti
          WHERE ti.ticket_id = t.id
            AND ti.queue_entry_id IS NOT NULL
            AND ti.queue_entry_id <> ''
            AND ti.name IS NOT NULL
            AND ti.name <> ''
        ),
        '{}'::text[]
      )
    ) AS x
  )
)
WHERE t.status = 'open';

-- ─────────────────────────────────────────────────────────
-- 2a. Skip ticket_items on closed (20260521230000)
-- ─────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────
-- 2b. Trigger-only scope follow-up (20260521230500)
-- ─────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────
-- 3. Drop completed_services update propagation (20260521233000)
-- ─────────────────────────────────────────────────────────
-- Stop History-modal edits to completed_services from auto-inserting ticket_items
-- lines on already-closed tickets. The INSERT trigger still runs on initial
-- completion so first-time ticket creation works as before — only post-hoc
-- edits via EditCompletedModal now stay scoped to History without
-- ghost-writing into the ticket.
--
-- Symptom we just hit (2026-05-21):
--   - Ticket #15 (Elena): phantom "Gel Fill / TAMMY" line appeared after the
--     ticket was closed. The History edit added "Gel Fill" to Tammy's
--     completed_services row, which fired the UPDATE trigger →
--     tickets_ensure_for_visit → INSERT new ticket_item.
--   - Ticket #9 (Anette): same pattern — phantom "Gel Full Set / TOMMY".
--   - Kelly's "Erica" row: services array gained a duplicate "Gel Pedicure"
--     via a History edit, padding turn_value.
--
-- All three had completed_services.edited = true, which proves the entrypoint.
--
-- Cashier-side ticket edits should be done via TicketModal directly. History
-- edits via EditCompletedModal will continue to update the History view + the
-- manicurist's turn totals, but will NO LONGER cascade into ticket_items.
DROP TRIGGER IF EXISTS trg_tickets_on_completed_update ON public.completed_services;


-- =========================================================================
-- Verification queries. After COMMIT, run these to confirm the trigger
-- definitions match what's intended.
-- =========================================================================

-- Should return 1 row: silently_skip_ticket_items_on_closed_ticket attached
-- to public.ticket_items as a BEFORE INSERT trigger.
SELECT tgname, tgrelid::regclass AS table, tgenabled
FROM pg_trigger
WHERE tgname = 'ticket_items_skip_on_closed';

-- Should return ZERO rows. If trg_tickets_on_completed_update is still here,
-- the drop didn't take and phantom lines will keep coming back.
SELECT tgname, tgrelid::regclass AS table, tgenabled
FROM pg_trigger
WHERE tgname = 'trg_tickets_on_completed_update';

-- The function definition you care about — should mention per-(source_row,
-- service) tuple logic. Look for 'v_tuple :=' and 'tombstone' in the body.
SELECT proname,
       length(prosrc) AS body_chars,
       substring(prosrc from 1 for 200) AS preview
FROM pg_proc
WHERE proname = 'tickets_ensure_for_visit';

COMMIT;

