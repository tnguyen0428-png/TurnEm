-- A staff change on a CLOSED ticket silently dropped the price snapshot.
--
-- Observed live on ticket #79 (Arleth, 08/19): the cashier moved the Gel
-- Pedicure line from DANNY to another person. The line UPDATE fired
-- trg_reprice_completed_services_on_item_change, which repriced the visit while
-- the completed_services row still named DANNY -- no line matched that staff,
-- so pass 3 nulled price_cents (5500 -> null), correctly. The app then moved the
-- completed row to the new staff, at which point line and row agreed again --
-- but nothing repriced, because completed_services carries no such trigger. The
-- $55.00 was gone from the row for good: the ticket is already closed, so the
-- close-time reprice will never run again.
--
-- Give the other half of the pair the same reflex. Staff and service name are
-- exactly the two fields price matching keys on, so a change to either is a
-- reason to recompute.
create or replace function public.reprice_on_completed_staff_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_visit  text;
  v_ticket uuid;
begin
  v_visit := public.tickets_visit_id(NEW.id);
  if v_visit is null then
    return null;
  end if;

  -- Every ticket that could hold this row's money. Scoped by VISIT rather than
  -- ticket id so a second visit whose lines landed on the first visit's ticket
  -- is covered too -- same reasoning as reprice_completed_services_for_ticket.
  for v_ticket in
    select t.id
      from public.tickets t
     where t.status = 'closed'
       and t.queue_entry_id is not null
       and public.tickets_visit_id(t.queue_entry_id) = v_visit
  loop
    perform public.reprice_completed_services_for_ticket(v_ticket);
  end loop;

  return null;
end;
$fn$;

-- AFTER UPDATE OF (manicurist_id, services) only: the recompute itself writes
-- price_cents and nothing else, so it cannot re-enter this trigger.
drop trigger if exists trg_reprice_on_completed_staff_change on public.completed_services;
create trigger trg_reprice_on_completed_staff_change
after update of manicurist_id, services on public.completed_services
for each row
when (old.manicurist_id is distinct from new.manicurist_id
      or old.services is distinct from new.services)
execute function public.reprice_on_completed_staff_change();
