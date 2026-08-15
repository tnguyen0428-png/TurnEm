-- Scope a void's completed_services cleanup to the ticket's OWN lines.
--
-- void_completed_services_for_visit() deletes every row matching the visit
-- prefix. That is wrong whenever TWO tickets share one visit id, which is
-- exactly what void-and-recreate produces: on 2026-08-13 voiding Katie's
-- ticket #30 (KELLY, one line) also deleted KATELYN's Gel Manicure row from
-- ticket #23, erasing credited work on a ticket that was never voided.
--
-- A line's queue_entry_id can carry a `#N` collision suffix (see
-- appendItemsToTicket) that never appears in a completed_services id, so
-- strip it before matching.
--
-- The no-lines case is preserved: when the cashier stripped every line before
-- voiding there is nothing to scope to, and the visit prefix is the only way
-- to reach the orphaned rows. That is what the prefix-only behaviour existed
-- for. void_completed_services_for_visit() is left in place unchanged.
create or replace function void_completed_services_for_ticket(p_ticket_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_visit text;
  v_lines int;
begin
  -- Same authority tie as the visit-scoped version: only ever deletes rows for
  -- a ticket the app has ALREADY marked voided, so it cannot remove live
  -- credited work even if invoked directly.
  select queue_entry_id into v_visit
  from tickets
  where id = p_ticket_id and status = 'voided';
  if not found then
    raise exception 'No voided ticket found for id %', p_ticket_id;
  end if;

  select count(*) into v_lines
  from ticket_items
  where ticket_id = p_ticket_id and queue_entry_id is not null;

  perform set_config('app.allow_clear', 'on', true);

  if v_lines > 0 then
    with del as (
      delete from completed_services cs
      where cs.id in (
        select distinct split_part(ti.queue_entry_id, '#', 1)
        from ticket_items ti
        where ti.ticket_id = p_ticket_id
          and ti.queue_entry_id is not null
      )
      returning 1
    )
    select count(*) into v_count from del;
  else
    with del as (
      delete from completed_services
      where v_visit is not null
        and (id = v_visit or id like v_visit || '-%')
      returning 1
    )
    select count(*) into v_count from del;
  end if;

  return v_count;
end;
$$;

grant execute on function void_completed_services_for_ticket(uuid) to anon, authenticated, service_role;
