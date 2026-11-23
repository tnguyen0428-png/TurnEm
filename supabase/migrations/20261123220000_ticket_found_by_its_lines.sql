-- A ticket belongs to every visit it has lines for, not just the visit in its
-- header.
--
-- Vicky Blake, 2026-11-23. She was checked in (visit A, ticket #6), sent back
-- to the book, and checked in again (visit B, ticket #8). The register's
-- same-client merge kept #6, moved #8's lines onto it and deleted #8 — but
-- #6's header still said visit A. Three places look a ticket up by its header
-- only, and all three then missed #6 for visit B:
--   1. tickets_ensure_for_visit: when #6 was paid, the History rows for
--      visit B fired it, it found no ticket for B, and opened ticket #10 with
--      the same services. #10 was paid as well ($132 twice, MACY and ANN
--      credited double) and had to be voided.
--   2. reprice_completed_services_for_ticket: paying #6 priced visit A only,
--      so B's History rows were left unpriced (the portal would have fallen
--      back to menu price had #10 not existed).
--   3. reprice_on_completed_staff_change: same header-only lookup.
-- Same shape: Cheryl Duncan 2026-10-24 (#35 / #50).
--
-- Fix: each of the three also finds a ticket through its LINES. A paid
-- ticket found that way is final — no second ticket is opened for its visit.

-- Lines are looked up by visit; this keeps that an index lookup.
create index if not exists idx_ticket_items_visit_id
  on public.ticket_items (public.tickets_visit_id(queue_entry_id))
  where queue_entry_id is not null;

-- ── Pricing, per visit ─────────────────────────────────────────────────────
-- The body of the old per-ticket function, unchanged, keyed on a visit.
create or replace function public.reprice_completed_services_for_visit(p_visit text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_visit is null then
    return;
  end if;

  -- 0. The paid ticket decides the tech. (migration 20261123120000)
  with want as (
    select cs.id, cs.manicurist_id as old_id, cs.manicurist_name as old_name,
           cs.client_name, array_to_string(cs.services, ' + ') as services,
           cs.price_cents as old_cents,
           p.staff1_id, coalesce(m.name, p.staff1_name) as new_name,
           coalesce(m.color, p.staff1_color, cs.manicurist_color) as new_color,
           p.cents, p.ticket_number, p.business_date
    from public.completed_services cs
    cross join lateral public.paid_ticket_staff_for_entry(cs.id) p
    left join public.manicurists m on m.id = p.staff1_id
    where public.tickets_visit_id(cs.id) = p_visit
      and not coalesce(cs.voided, false)
      and p.staff1_id is distinct from cs.manicurist_id
  ),
  moved as (
    update public.completed_services cs
       set manicurist_id    = w.staff1_id,
           manicurist_name  = w.new_name,
           manicurist_color = w.new_color
      from want w
     where cs.id = w.id
    returning w.*
  )
  insert into public.ticket_tech_moves
    (source, business_date, ticket_number, entry_id, client_name, services,
     from_tech_id, from_tech, to_tech_id, to_tech, old_cents, new_cents)
  select 'live', business_date, ticket_number, id, client_name, services,
         old_id, old_name, staff1_id, new_name, old_cents, cents
  from moved;

  update public.completed_services cs
  set price_cents = (
    select sum(ti.ext_price_cents)
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.status = 'closed'
      and ti.queue_entry_id is not null
      and split_part(ti.queue_entry_id, '#', 1) = cs.id
      and (ti.staff1_id is null or cs.manicurist_id is null
           or ti.staff1_id = cs.manicurist_id)
  )
  where public.tickets_visit_id(cs.id) = p_visit
    and exists (
      select 1
      from public.ticket_items ti
      join public.tickets t on t.id = ti.ticket_id
      where t.status = 'closed'
        and ti.queue_entry_id is not null
        and split_part(ti.queue_entry_id, '#', 1) = cs.id
        and (ti.staff1_id is null or cs.manicurist_id is null
             or ti.staff1_id = cs.manicurist_id)
    );

  update public.completed_services cs
  set price_cents = public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services)
  where public.tickets_visit_id(cs.id) = p_visit
    and cs.id like '%-add-%'
    and public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) is not null;

  update public.completed_services cs
  set price_cents = null
  where public.tickets_visit_id(cs.id) = p_visit
    and cs.price_cents is not null
    and not exists (
      select 1
      from public.ticket_items ti
      join public.tickets t on t.id = ti.ticket_id
      where t.status = 'closed'
        and ti.queue_entry_id is not null
        and split_part(ti.queue_entry_id, '#', 1) = cs.id
        and (ti.staff1_id is null or cs.manicurist_id is null
             or ti.staff1_id = cs.manicurist_id)
    )
    and public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) is null;
end;
$function$;

-- ── 2. Pricing a ticket: its header visit AND every visit on its lines ─────
create or replace function public.reprice_completed_services_for_ticket(p_ticket_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_visit text;
begin
  for v_visit in
    select distinct v from (
      select public.tickets_visit_id(t.queue_entry_id) as v
      from public.tickets t where t.id = p_ticket_id
      union
      select public.tickets_visit_id(ti.queue_entry_id)
      from public.ticket_items ti
      where ti.ticket_id = p_ticket_id and ti.queue_entry_id is not null
    ) s
    where v is not null
  loop
    perform public.reprice_completed_services_for_visit(v_visit);
  end loop;
end;
$function$;

-- ── 3. A tech/service change on a History row: price its visit ────────────
create or replace function public.reprice_on_completed_staff_change()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_visit text;
begin
  v_visit := public.tickets_visit_id(NEW.id);
  if v_visit is null then
    return null;
  end if;

  if exists (
       select 1 from public.tickets t
       where t.status = 'closed'
         and t.queue_entry_id is not null
         and public.tickets_visit_id(t.queue_entry_id) = v_visit)
     or exists (
       select 1 from public.ticket_items ti
       join public.tickets t on t.id = ti.ticket_id
       where t.status = 'closed'
         and ti.queue_entry_id is not null
         and public.tickets_visit_id(ti.queue_entry_id) = v_visit) then
    perform public.reprice_completed_services_for_visit(v_visit);
  end if;

  return null;
end;
$function$;

-- ── 1. Opening a ticket for a visit: find it through its lines too ─────────
-- Identical to migration 20261123180000 apart from the block marked
-- "Found through its lines".
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

  v_is_add_child := (p_source_row_id IS NOT NULL AND p_source_row_id LIKE '%-add-%');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_visit_id, 0));

  SELECT id, status, auto_attributed_sources
    INTO v_ticket_id, v_ticket_status, v_attributed
  FROM tickets
  WHERE public.tickets_visit_id(queue_entry_id) = p_visit_id
  ORDER BY (status = 'open') DESC, opened_at DESC
  LIMIT 1;

  -- Found through its lines (migration 20261123220000): a ticket whose header
  -- names another visit but which already carries this visit's services —
  -- what the register's same-client merge leaves behind. Voided tickets do
  -- not count: re-ringing a voided visit is legitimate.
  IF v_ticket_id IS NULL THEN
    SELECT t.id, t.status, t.auto_attributed_sources
      INTO v_ticket_id, v_ticket_status, v_attributed
    FROM tickets t
    WHERE t.status IN ('open', 'closed')
      AND EXISTS (
        SELECT 1 FROM ticket_items ti
        WHERE ti.ticket_id = t.id
          AND ti.queue_entry_id IS NOT NULL
          AND public.tickets_visit_id(ti.queue_entry_id) = p_visit_id)
    ORDER BY (t.status = 'open') DESC, t.opened_at DESC
    LIMIT 1;
  END IF;

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
