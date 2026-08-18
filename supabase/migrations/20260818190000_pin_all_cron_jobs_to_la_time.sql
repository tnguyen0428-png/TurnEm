-- Pin every scheduled job to Los Angeles time, permanently.
--
-- pg_cron here runs on cron.timezone = GMT and that cannot be changed from a
-- migration, so a fixed UTC schedule drifts an hour every time LA switches
-- between PDT (UTC-7) and PST (UTC-8). That drift is why the original 9pm job
-- silently became a 10pm job back in April.
--
-- The fix, applied uniformly: every job fires at BOTH candidate UTC hours and
-- refuses to do anything unless the LA wall clock reads the intended hour. One
-- of the two firings always matches, in either half of the year, so each job
-- runs exactly once a night at a fixed LA time forever.
--
--   nightly-earnings-reconcile   9:00 PM LA
--   prune_daily_history_14d      9:00 PM LA
--   nightly-save-history        11:59 PM LA
--   morning-board-reset          2:00 AM LA

create or replace function public.la_hour()
returns int
language sql
stable
set search_path = public
as $$ select extract(hour from (now() at time zone 'America/Los_Angeles'))::int $$;

comment on function public.la_hour() is
  'Current hour (0-23) on the Los Angeles wall clock. The gate every nightly cron job uses so a GMT-scheduled job keeps a fixed LA time across DST.';

-- The prune cutoff read bare CURRENT_DATE, which is the UTC date — and every
-- run happens after 5pm LA, when UTC is already tomorrow. That made the cutoff
-- 13 days, not 14. Anchor it to the LA date like everything else.
create or replace function public.prune_daily_history_older_than_14d()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff  text := to_char(((now() at time zone 'America/Los_Angeles')::date - interval '14 days'), 'YYYY-MM-DD');
  removed integer;
begin
  delete from public.daily_history where date < cutoff;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- 9:00 PM LA = 04:00 UTC (PDT) / 05:00 UTC (PST)
select cron.schedule('nightly-earnings-reconcile', '0 4,5 * * *',
  $$select public.nightly_reconcile_earnings();$$);

select cron.schedule('prune_daily_history_14d', '0 4,5 * * *',
  $$do $do$ begin if public.la_hour() = 21 then perform public.prune_daily_history_older_than_14d(); end if; end $do$;$$);

-- 2:00 AM LA = 09:00 UTC (PDT) / 10:00 UTC (PST)
select cron.schedule('morning-board-reset', '0 9,10 * * *',
  $$do $do$ begin if public.la_hour() = 2 then perform public.scheduled_morning_reset(); end if; end $do$;$$);

-- 11:59 PM LA = 06:59 UTC (PDT) / 07:59 UTC (PST)
--
-- This job's command carries a service-role bearer token inline, so the new
-- command is built FROM the existing one rather than retyped: the secret is
-- never written into this file or into git. (It remains in cron.job.command in
-- plaintext, as before — worth rotating into Vault separately.)
do $mig$
declare
  v_cmd text;
begin
  select regexp_replace(regexp_replace(command, '^\s*SELECT\s+', '', 'i'), ';\s*$', '')
    into v_cmd
    from cron.job
   where jobname = 'nightly-save-history';

  if v_cmd is null or v_cmd not like '%net.http_post%' then
    raise exception 'nightly-save-history command not found or unexpected shape; aborting rather than clobbering it';
  end if;

  perform cron.schedule('nightly-save-history', '59 6,7 * * *',
    format('do $do$ begin if public.la_hour() = 23 then perform %s; end if; end $do$;', v_cmd));
end
$mig$;
