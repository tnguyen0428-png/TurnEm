-- A ticket line may only price a completed_services row belonging to the same
-- manicurist.
--
-- The gap
-- =======
-- Both pricing paths group ticket lines by queue_entry_id with the '#N' line
-- suffix stripped, and write that sum to the matching completed_services id.
-- Nothing checks WHO the line was credited to. When two techs share one visit
-- id — the bare id is tech A's entry, and tech B's line hangs off it as
-- '<visit>#N' — tech A's row is handed both amounts.
--
-- Live example, 2026-08-15 ticket #57 (Kate):
--   Pedicure              MIA   (mani-7)  qid '3b799da5…'    $40
--   Acrylic Removal Only  BRIAN (mani-13) qid '3b799da5…#1'  $20
-- MIA's row archived at $60 for a $40 pedicure, and BRIAN's add-child row
-- ('3b799da5…-add-mani-13') stayed null. The staff portal then showed MIA $20
-- over the blueprint for the day, with BRIAN short the same $20.
--
-- This is the hazard the 2026-08-13 notes flagged as "two DIFFERENT techs can
-- share one visit id, and summing gives A both amounts" — it was fixed in the
-- one-off backfill script at the time but never in the triggers themselves.
--
-- The fix
-- =======
-- Scope both passes to lines whose staff1_id matches the row's manicurist_id.
-- A line with no staff, or a row with no manicurist, keeps the old unscoped
-- behaviour so nothing that relies on it regresses.
--
-- A row left with no line of its own now stays null rather than taking another
-- tech's money. add_child_price_cents (migration 20260817000000) picks up the
-- released amount for the add-child that actually earned it, and the staff
-- portal's own remainder fallback covers whatever neither reaches.

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
    and split_part(ti.queue_entry_id, '#', 1) = NEW.id
    and (ti.staff1_id is null or NEW.manicurist_id is null
         or ti.staff1_id = NEW.manicurist_id);

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
  -- completed_services.id, or that id || '#' || line_index. Written as a
  -- correlated subquery rather than a grouped join so the staff scope can be
  -- expressed per row — grouping by (cs_id, staff1_id) would leave two
  -- candidate groups for a row with no manicurist and let Postgres pick one.
  UPDATE public.completed_services cs
  SET price_cents = (
    SELECT SUM(ti.ext_price_cents)
    FROM public.ticket_items ti
    WHERE ti.ticket_id = NEW.id
      AND ti.queue_entry_id IS NOT NULL
      AND split_part(ti.queue_entry_id, '#', 1) = cs.id
      AND (ti.staff1_id IS NULL OR cs.manicurist_id IS NULL
           OR ti.staff1_id = cs.manicurist_id)
  )
  WHERE EXISTS (
    SELECT 1
    FROM public.ticket_items ti
    WHERE ti.ticket_id = NEW.id
      AND ti.queue_entry_id IS NOT NULL
      AND split_part(ti.queue_entry_id, '#', 1) = cs.id
      AND (ti.staff1_id IS NULL OR cs.manicurist_id IS NULL
           OR ti.staff1_id = cs.manicurist_id)
  );

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
