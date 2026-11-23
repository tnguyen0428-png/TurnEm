-- A re-checked-in client keeps their open ticket instead of getting a second.
--
-- Haley Seder and Maddie Samuelian, 2026-11-20. Each was checked in, sent back
-- off the board (REMOVE_CLIENT / back to the appointment book), then checked
-- in again. A re-check-in mints a NEW visit id. Two things then opened tickets
-- by different rules:
--   * the app (syncQueue) looks for the client's open ticket today by name and
--     appended the new visit's services to the OLD ticket (#33 / #39);
--   * this function, fired by the queue/completed triggers, keys only on the
--     visit id, found nothing for the new visit, and opened a SECOND ticket
--     (#41 / #55) with the same services.
-- Same services on two open tickets = a double charge waiting to happen. The
-- front desk caught both, voided both as "dupe" and re-rang the clients as
-- fresh walk-ins ("Haley Seder 2", "Maddie") with 6-second fake services.
-- Same shape on 10/24 (×2), 10/29 (×2), 10/30, 11/06: 8 "dup" voids in 30 days.
--
-- Fix: before opening a new ticket, reuse the client's OPEN ticket for today
-- when that ticket's own visit is gone from the board — no queue entry and no
-- live History row left for it. That is exactly a re-check-in. The ticket's
-- header is re-pointed at the new visit, so everything keyed on the header
-- (pricing at close, appointment completion, the app's visit lookups) follows.
--
-- Deliberately NOT a plain name match: two different "Sarah"s who are both
-- actually in the salon each still have a live visit, so neither ticket
-- qualifies and they stay separate. The generic "Walk-in" name never matches.
--
-- No double lines: when the old ticket already carries a line for the same
-- service and tech, the existing guard below skips the insert, and the
-- per-service tombstones it writes stop the app's append from adding it again.

create or replace function public.tickets_ensure_for_visit(p_visit_id text, p_business_date date, p_client_name text, p_manicurist_id text, p_opened_at timestamp with time zone, p_services text[], p_source_row_id text)
 returns uuid
 language plpgsql
as $function$
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
  v_is_add_child boolean;
  v_client_key text;
BEGIN
  IF p_visit_id IS NULL OR p_visit_id = '' THEN
    RETURN NULL;
  END IF;

  -- Cashier-driven add-children carry a '-add-' marker in their id.
  -- We still let the function find / create / update the ticket so
  -- downstream realtime echoes have a stable identity, but we skip
  -- the service-loop INSERTs entirely. TicketModal.updateOpenTicket
  -- owns ticket_items for these rows.
  v_is_add_child := (p_source_row_id IS NOT NULL AND p_source_row_id LIKE '%-add-%');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_visit_id, 0));

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

  -- Re-check-in: reuse the client's open ticket whose visit has left the
  -- board, instead of opening a second one. (migration 20261123180000)
  v_client_key := lower(regexp_replace(trim(coalesce(p_client_name, '')), '\s+', ' ', 'g'));
  IF v_ticket_id IS NULL AND NOT v_is_add_child
     AND v_client_key NOT IN ('', 'walk-in', 'walkin', 'walk in') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('client:' || p_business_date::text || ':' || v_client_key, 0));

    SELECT t.id, t.status, t.auto_attributed_sources
      INTO v_ticket_id, v_ticket_status, v_attributed
    FROM tickets t
    WHERE t.business_date = p_business_date
      AND t.status = 'open'
      AND t.queue_entry_id IS NOT NULL
      AND lower(regexp_replace(trim(t.client_name), '\s+', ' ', 'g')) = v_client_key
      AND NOT EXISTS (
        SELECT 1 FROM queue_entries q
        WHERE public.tickets_visit_id(coalesce(nullif(q.parent_queue_id, ''), q.id))
              = public.tickets_visit_id(t.queue_entry_id))
      AND NOT EXISTS (
        SELECT 1 FROM completed_services cs
        WHERE public.tickets_visit_id(cs.id) = public.tickets_visit_id(t.queue_entry_id)
          AND NOT coalesce(cs.voided, false))
    ORDER BY t.opened_at DESC
    LIMIT 1;

    IF v_ticket_id IS NOT NULL THEN
      UPDATE tickets
         SET queue_entry_id = p_visit_id,
             updated_at     = NOW()
       WHERE id = v_ticket_id;
    END IF;
  END IF;

  IF v_ticket_id IS NULL THEN
    -- New ticket creation is NOT triggered by add-children — the parent
    -- visit already has (or will have) a ticket from its primary queue
    -- entries. Bail out so we don't accidentally open a second ticket.
    IF v_is_add_child THEN
      RETURN NULL;
    END IF;

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

    v_attributed := '{}'::text[];
  ELSE
    IF p_manicurist_id IS NOT NULL AND NOT v_is_add_child THEN
      SELECT name, color INTO v_pname, v_pcolor FROM manicurists WHERE id = p_manicurist_id;
      UPDATE tickets SET
        primary_manicurist_id = p_manicurist_id,
        primary_manicurist_name = COALESCE(v_pname, ''),
        primary_manicurist_color = COALESCE(v_pcolor, '#9ca3af')
      WHERE id = v_ticket_id
        AND (primary_manicurist_id IS NULL OR primary_manicurist_id = '');
    END IF;
  END IF;

  -- ADD-CHILD SHORT-CIRCUIT: stop here. The cashier's updateOpenTicket
  -- path will INSERT the ticket_items. Record per-service tombstones for
  -- every service in p_services so a follow-up trigger fire (whether
  -- from this row or from re-saves of the parent visit's queue entries)
  -- still respects the tombstones and never tries to insert these
  -- lines later.
  IF v_is_add_child THEN
    IF p_services IS NOT NULL THEN
      FOREACH v_svc_name IN ARRAY p_services LOOP
        IF v_svc_name IS NULL OR trim(v_svc_name) = '' THEN CONTINUE; END IF;
        v_tuple := COALESCE(p_source_row_id, '') || '::' || v_svc_name;
        v_new_tuples := array_append(v_new_tuples, v_tuple);
      END LOOP;
    END IF;
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
    RETURN v_ticket_id;
  END IF;

  -- ── Non-add-child path: preserved verbatim from prior definition ──

  SELECT COALESCE(MAX(sort_order), -1) INTO v_sort_max FROM ticket_items WHERE ticket_id = v_ticket_id;

  SELECT name, color INTO v_staff_name, v_staff_color FROM manicurists WHERE id = p_manicurist_id;
  v_staff_name := COALESCE(v_staff_name, '');
  v_staff_color := COALESCE(v_staff_color, '#9ca3af');

  IF p_services IS NOT NULL THEN
    FOREACH v_svc_name IN ARRAY p_services LOOP
      v_line_idx := v_line_idx + 1;
      IF v_svc_name IS NULL OR trim(v_svc_name) = '' THEN CONTINUE; END IF;

      v_tuple := COALESCE(p_source_row_id, '') || '::' || v_svc_name;
      IF v_tuple = ANY(COALESCE(v_attributed, '{}'::text[])) THEN
        CONTINUE;
      END IF;

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
