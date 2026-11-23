-- Every minute, free a tech card that points at a client who is gone.
--
-- KATELYN, 2026-11-23: Emily Dewitt's service finished at 11:49 and freed her
-- card; a screen that had not caught up then wrote "busy with Emily" back.
-- Emily was no longer on the board, so the card pointed at nothing, the
-- rotation skipped KATELYN, and nothing cleaned it up for ~40 minutes. The
-- app only repairs such a card when a screen LOADS (reducer LOAD_STATE), and
-- the front desk stays open all day.
--
-- The sync fix (save only changed fields, commit afabf60) removes the usual
-- cause; this sweep is the backstop for whatever is left.
--
-- Grace period: a card can briefly point at a client whose queue row hasn't
-- landed yet (separate saves from one screen). So a dead pointer is only
-- acted on once the SAME pointer has been seen dead for 2+ minutes. Each
-- repair is logged in stuck_card_log.

create table if not exists public.stuck_card_seen (
  manicurist_id   text primary key,
  client_id       text not null,
  first_seen_at   timestamptz not null default now()
);
alter table public.stuck_card_seen enable row level security;

create table if not exists public.stuck_card_log (
  id              bigint generated always as identity primary key,
  freed_at        timestamptz not null default now(),
  manicurist_id   text not null,
  manicurist_name text,
  old_status      text,
  client_id       text,
  client_name     text,     -- from History if the client was finished
  first_seen_at   timestamptz
);
alter table public.stuck_card_log enable row level security;
comment on table public.stuck_card_log is
  'Tech cards freed by sweep_stuck_cards() because they pointed at a client no longer on the board. See migration 20261123230000.';

create or replace function public.sweep_stuck_cards(p_grace interval default interval '2 minutes')
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_n int;
begin
  -- Forget pointers that are live again, changed, or cleared.
  delete from public.stuck_card_seen s
  where not exists (
          select 1 from public.manicurists m
          where m.id = s.manicurist_id
            and m.current_client_id = s.client_id
            and not exists (select 1 from public.queue_entries q where q.id = m.current_client_id));

  -- Note every dead pointer, keeping its first sighting.
  insert into public.stuck_card_seen (manicurist_id, client_id)
  select m.id, m.current_client_id
  from public.manicurists m
  where m.current_client_id is not null
    and not exists (select 1 from public.queue_entries q where q.id = m.current_client_id)
  on conflict (manicurist_id) do nothing;

  -- Free the ones dead for longer than the grace period.
  with targets as (
    select m.id, m.name, m.status as old_status, s.client_id, s.first_seen_at
    from public.manicurists m
    join public.stuck_card_seen s on s.manicurist_id = m.id
    where m.current_client_id = s.client_id
      and s.first_seen_at <= now() - p_grace
      and not exists (select 1 from public.queue_entries q where q.id = m.current_client_id)
  ),
  freed as (
    update public.manicurists m
       set current_client_id = null,
           -- 'break' stays 'break'; only a busy card goes back to available.
           status = case when m.status = 'busy' then 'available' else m.status end
      from targets t
     where m.id = t.id
       and m.current_client_id = t.client_id
    returning t.id, t.name, t.old_status, t.client_id, t.first_seen_at
  ),
  logged as (
    insert into public.stuck_card_log
      (manicurist_id, manicurist_name, old_status, client_id, client_name, first_seen_at)
    select f.id, f.name, f.old_status, f.client_id,
           (select c.client_name from public.completed_services c where c.id = f.client_id limit 1),
           f.first_seen_at
    from freed f
    returning 1
  )
  select count(*) into v_n from logged;

  delete from public.stuck_card_seen s
  where not exists (select 1 from public.manicurists m
                    where m.id = s.manicurist_id and m.current_client_id = s.client_id);

  return v_n;
end;
$fn$;

-- Every minute. Idempotent: re-running the migration replaces the job.
select cron.unschedule(jobid) from cron.job where jobname = 'sweep-stuck-cards';
select cron.schedule('sweep-stuck-cards', '* * * * *', $$select public.sweep_stuck_cards();$$);
