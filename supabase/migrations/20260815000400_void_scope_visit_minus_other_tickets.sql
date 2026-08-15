-- Single definition of "which completed_services rows does voiding THIS ticket
-- remove". Both extremes are wrong:
--
--   visit prefix only  -- reaches into a second ticket sharing the visit id
--     (void-and-recreate). Voiding Katie's #30 deleted KATELYN's row from #23
--     on 2026-08-13.
--   ticket lines only  -- misses rows whose id is not a line qid, e.g. an
--     add-child (`-add-mani-10`) when the line fell back to the bare visit id
--     (September, 2026-08-14). Those survive the void still credited, which is
--     exactly what a void is meant to undo.
--
-- Correct rule: everything on this visit, PLUS this ticket's own line ids (a
-- ticket's header visit and its lines' visit can disagree -- #23's header said
-- 895e5373 while its lines said d5fb2605), MINUS anything claimed by a
-- different ticket that is not itself voided.
create or replace function completed_service_ids_for_ticket_void(p_ticket_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select id, queue_entry_id from tickets where id = p_ticket_id
  ),
  mine as (
    select distinct split_part(ti.queue_entry_id, '#', 1) as cs_id
    from ticket_items ti, me
    where ti.ticket_id = me.id and ti.queue_entry_id is not null
    union
    select cs.id
    from completed_services cs, me
    where me.queue_entry_id is not null
      and (cs.id = me.queue_entry_id or cs.id like me.queue_entry_id || '-%')
  ),
  claimed_elsewhere as (
    select distinct split_part(ti.queue_entry_id, '#', 1) as cs_id
    from ticket_items ti
    join tickets t on t.id = ti.ticket_id
    where t.id <> p_ticket_id
      and t.status <> 'voided'
      and ti.queue_entry_id is not null
  )
  select m.cs_id from mine m
  where m.cs_id is not null
    and m.cs_id <> ''
    and not exists (select 1 from claimed_elsewhere c where c.cs_id = m.cs_id);
$$;

grant execute on function completed_service_ids_for_ticket_void(uuid) to anon, authenticated, service_role;

-- Delete through the same rule so the client's refund pass and the server's
-- delete can never disagree about which rows a void covers. A row deleted
-- without being refunded is the one way a turn survives a void.
create or replace function void_completed_services_for_ticket(p_ticket_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if not exists (select 1 from tickets where id = p_ticket_id and status = 'voided') then
    raise exception 'No voided ticket found for id %', p_ticket_id;
  end if;

  perform set_config('app.allow_clear', 'on', true);

  with del as (
    delete from completed_services
    where id in (select completed_service_ids_for_ticket_void(p_ticket_id))
    returning 1
  )
  select count(*) into v_count from del;

  return v_count;
end;
$$;
