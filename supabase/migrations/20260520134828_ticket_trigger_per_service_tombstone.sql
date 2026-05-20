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
