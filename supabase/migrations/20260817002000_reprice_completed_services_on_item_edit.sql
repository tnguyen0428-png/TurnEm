-- Keep price_cents in step with the receipt after a closed ticket is edited.
--
-- The gap
-- =======
-- price_cents is a ONE-SHOT write. trg_sync_completed_service_prices fires on
-- the ticket's transition to closed and never again, and
-- trg_price_completed_service_on_insert only fires for a row arriving later.
-- Editing a line on an already-closed ticket is permitted — only INSERTs are
-- blocked (reject_ticket_items_on_closed_ticket_unconditional) — so the
-- snapshot silently goes stale, and because the staff portal prefers
-- price_cents over every fallback, the stale value is what staff see.
--
-- Two live cases on 2026-08-15, both repaired by hand:
--   KIMBERLY, Susan  archived $80, receipt $67  (line edited down after close)
--   LY, Lani         archived $55, receipt $105 (entry consolidated to cover
--                                                both services, price left behind)
--
-- The fix
-- =======
-- Re-run the pricing whenever a line on a CLOSED ticket changes. While a
-- ticket is open there is nothing to correct: price_cents is not written yet
-- and the portal reads the live ticket instead.
--
-- The recompute is factored out so the close-time trigger and this one can
-- never drift apart. It is scoped by VISIT rather than by ticket id, which
-- also covers the known case of a client's second visit appending its lines to
-- the first visit's still-open ticket.

create or replace function public.reprice_completed_services_for_ticket(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit text;
begin
  select public.tickets_visit_id(queue_entry_id) into v_visit
  from public.tickets where id = p_ticket_id;
  if v_visit is null then
    return;
  end if;

  -- 1. Rows reachable by id, scoped to the row's own manicurist so one tech's
  --    line can never be summed into another's row.
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
  where public.tickets_visit_id(cs.id) = v_visit
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

  -- 2. Add-children, whose line carries the bare visit id and so is invisible
  --    to pass 1. See migration 20260817000000.
  update public.completed_services cs
  set price_cents = public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services)
  where public.tickets_visit_id(cs.id) = v_visit
    and cs.id like '%-add-%'
    and public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) is not null;

  -- 3. A row that owns no line ANYWHERE any more — its line was deleted, or
  --    re-credited to another tech — must not keep the price it was given
  --    before that happened. Null lets the portal's remainder fallback take
  --    over. The check spans every closed ticket, not just this one, so a row
  --    whose lines legitimately sit on a different ticket is left alone.
  update public.completed_services cs
  set price_cents = null
  where public.tickets_visit_id(cs.id) = v_visit
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
$$;

comment on function public.reprice_completed_services_for_ticket(uuid) is
  'Recompute price_cents for every completed_services row on a ticket''s visit, staff-scoped, including add-children. Shared by the close-time trigger and the post-close edit trigger so the two can never drift.';


-- The close-time trigger now delegates, so both paths share one definition.
create or replace function public.sync_completed_service_prices()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status <> 'closed' then
    return NEW;
  end if;
  if OLD.status = 'closed' then
    return NEW;  -- already closed, no-op
  end if;

  perform public.reprice_completed_services_for_ticket(NEW.id);
  return NEW;
end;
$$;


create or replace function public.reprice_completed_services_on_item_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id  uuid;
  v_old_ticket uuid;
begin
  if TG_OP = 'DELETE' then
    v_ticket_id := OLD.ticket_id;
  else
    v_ticket_id := NEW.ticket_id;
    v_old_ticket := OLD.ticket_id;
  end if;

  if exists (select 1 from public.tickets where id = v_ticket_id and status = 'closed') then
    perform public.reprice_completed_services_for_ticket(v_ticket_id);
  end if;

  -- A line moved between tickets: the ticket it left needs recomputing too.
  if v_old_ticket is not null and v_old_ticket <> v_ticket_id
     and exists (select 1 from public.tickets where id = v_old_ticket and status = 'closed') then
    perform public.reprice_completed_services_for_ticket(v_old_ticket);
  end if;

  return null;  -- AFTER trigger; return value is ignored
end;
$$;

drop trigger if exists trg_reprice_completed_services_on_item_change on public.ticket_items;
create trigger trg_reprice_completed_services_on_item_change
  after update of unit_price_cents, quantity, discount_cents, ext_price_cents,
                  staff1_id, queue_entry_id, ticket_id
      or delete
  on public.ticket_items
  for each row
  execute function public.reprice_completed_services_on_item_change();
