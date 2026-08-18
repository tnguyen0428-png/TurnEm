-- Price the completed_services rows created by the cashier's "+ Add line".
--
-- The gap
-- =======
-- Both pricing paths match a ticket line to a completed_services row by id:
--   sync_completed_service_prices()      strips the '#N' line suffix off
--                                        ticket_items.queue_entry_id
--   price_completed_service_on_insert()  does the same via split_part
--
-- That works for every queue-driven row, but never for an add-child. The
-- cashier's "+ Add line" makes a queue entry '<visit>-add-<staff>', and
-- ticket_items_skip_add_child_qid (migration 20260522080000) drops any
-- ticket_items INSERT carrying that id — deliberately, because TicketModal
-- owns those lines. TicketModal.buildItemsForSave therefore writes them with
-- the BARE visit id instead. So the completed_services row is keyed
-- '<visit>-add-<staff>' while its money sits on a line keyed '<visit>', and
-- the two can never meet. price_cents stays null forever.
--
-- Six of the seven unpriced entries across 2026-08-15/16 were add-children.
-- The staff portal then fell back to a visit-level ticket sum, which also
-- swept up the sibling entry's money and overstated four manicurists
-- (MIA +$20, DANNY +$65, LY +$50, KIM +$20 on 08/16).
--
-- The fix
-- =======
-- A narrow fallback that fires ONLY for ids containing '-add-', matching by
-- (visit, staff, service name). Rows without '-add-' take exactly the path
-- they take today, so the blast radius is the set of rows that are null now.

create or replace function public.add_child_price_cents(
  p_cs_id          text,
  p_manicurist_id  text,
  p_services       text[]
) returns int
language sql
stable
security definer
set search_path = public
as $$
  with r as (select public.tickets_visit_id(p_cs_id) as visit)
  select sum(ti.ext_price_cents)::int
  from public.ticket_items ti
  join public.tickets t on t.id = ti.ticket_id
  cross join r
  where p_cs_id like '%-add-%'
    and r.visit is not null
    and p_manicurist_id is not null
    and t.status = 'closed'
    and ti.kind = 'service'
    and ti.staff1_id = p_manicurist_id
    and ti.name = any(coalesce(p_services, '{}'::text[]))
    -- The add-child's line carries the bare visit id (or, on legacy rows,
    -- nothing at all) — never the '-add-' id.
    and coalesce(split_part(ti.queue_entry_id, '#', 1), r.visit) = r.visit
    -- Don't steal a line that a queue-driven row of the SAME tech already
    -- owns by exact id. A bare-visit qid is a real entry id whenever the
    -- client wasn't split; then that entry is the owner, not this one.
    and not exists (
      select 1 from public.completed_services cs2
      where cs2.id = split_part(ti.queue_entry_id, '#', 1)
        and cs2.manicurist_id is not distinct from ti.staff1_id
    )
    -- Only claim when this add-child is the unambiguous claimant. Two
    -- add-children of one tech with the same service on one visit would each
    -- have an equal claim on the line, so neither gets it and the row stays
    -- null (the portal's own fallback covers the display). Counts OTHER rows
    -- only: on the BEFORE INSERT path p_cs_id is not in the table yet, so a
    -- test for exactly one match would never pass.
    and not exists (
      select 1 from public.completed_services cs3
      where cs3.id like r.visit || '%-add-%'
        and cs3.id <> p_cs_id
        and cs3.manicurist_id = p_manicurist_id
        and ti.name = any(cs3.services)
    )
$$;

comment on function public.add_child_price_cents(text, text, text[]) is
  'Receipt total for a "+ Add line" completed_services row, matched by (visit, staff, service) because its ticket line carries the bare visit id. Returns null for non-add-child ids and for ambiguous matches.';


-- ── Path 1: the row lands after its ticket already closed ──────────────────
create or replace function public.price_completed_service_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
begin
  if NEW.price_cents is not null then
    return NEW;
  end if;

  select sum(ti.ext_price_cents) into v_total
  from ticket_items ti
  join tickets t on t.id = ti.ticket_id
  where t.status = 'closed'
    and ti.queue_entry_id is not null
    and split_part(ti.queue_entry_id, '#', 1) = NEW.id;

  -- An add-child is never reachable by id; match it by (visit, staff, service).
  if v_total is null then
    v_total := public.add_child_price_cents(NEW.id, NEW.manicurist_id, NEW.services);
  end if;

  if v_total is not null then
    NEW.price_cents := v_total;
  end if;

  return NEW;
end;
$$;


-- ── Path 2: the ticket closes while the row already exists ─────────────────
create or replace function public.sync_completed_service_prices()
returns trigger
language plpgsql
security definer
as $$
BEGIN
  IF NEW.status <> 'closed' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'closed' THEN
    RETURN NEW;  -- already closed, no-op
  END IF;

  -- Rows reachable by id: queue_entry_id is either exactly the
  -- completed_services.id, or that id || '#' || line_index.
  UPDATE public.completed_services cs
  SET price_cents = sub.total_ext
  FROM (
    SELECT
      CASE
        WHEN ti.queue_entry_id LIKE '%#%'
        THEN left(ti.queue_entry_id, strpos(ti.queue_entry_id, '#') - 1)
        ELSE ti.queue_entry_id
      END AS cs_id,
      SUM(ti.ext_price_cents) AS total_ext
    FROM public.ticket_items ti
    WHERE ti.ticket_id = NEW.id
      AND ti.queue_entry_id IS NOT NULL
    GROUP BY 1
  ) sub
  WHERE cs.id = sub.cs_id;

  -- Add-children on this visit, which the pass above structurally cannot see.
  UPDATE public.completed_services cs
  SET price_cents = public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services)
  WHERE cs.price_cents IS NULL
    AND cs.id LIKE '%-add-%'
    AND public.tickets_visit_id(cs.id) = public.tickets_visit_id(NEW.queue_entry_id)
    AND public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) IS NOT NULL;

  RETURN NEW;
END;
$$;


-- ── Backfill: rows still on the board that the old logic could not price ───
UPDATE public.completed_services cs
SET price_cents = public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services)
WHERE cs.price_cents IS NULL
  AND cs.id LIKE '%-add-%'
  AND public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) IS NOT NULL;
