-- Standing 9pm LA reconciliation: portal vs blueprint, logged so a clean night
-- is provable and a dirty one is findable in the morning.
--
-- reconcile_staff_earnings has existed since 20260817003000 but nothing ever
-- called it — cron.job_run_details shows no run, ever. This is the job.
--
-- Timing: pg_cron here runs on cron.timezone = GMT, so no single UTC
-- expression holds 9pm LA year-round (9pm PDT = 04:00 UTC, 9pm PST = 05:00
-- UTC). The job fires at BOTH hours and the function no-ops unless the LA hour
-- is 21, so the payload runs exactly once a night in either half of the year.
--
-- Scope: yesterday and today. Today reconciles off the live board; yesterday is
-- re-checked because its archive is only final after the 11:59pm save, and a
-- closed ticket edited late in the evening moves yesterday's numbers.

create table if not exists public.earnings_reconciliation_log (
  id                   bigserial primary key,
  ran_at               timestamptz not null default now(),
  from_date            date        not null,
  to_date              date        not null,
  discrepancy_count    int         not null,
  total_abs_diff_cents bigint      not null,
  details              jsonb       not null default '[]'::jsonb
);

comment on table public.earnings_reconciliation_log is
  'One row per nightly reconciliation run. discrepancy_count = 0 means the portal and the blueprint agreed to the penny; details holds the disagreeing (date, tech) pairs when they did not.';

create index if not exists earnings_reconciliation_log_ran_at_idx
  on public.earnings_reconciliation_log (ran_at desc);

-- p_force skips the 21:00 gate for manual runs and testing.
create or replace function public.nightly_reconcile_earnings(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_la    timestamp := now() at time zone 'America/Los_Angeles';
  v_to    date;
  v_from  date;
  v_rows  jsonb;
  v_count int;
  v_abs   bigint;
begin
  if not p_force and extract(hour from v_la)::int <> 21 then
    return jsonb_build_object('skipped', true, 'la_hour', extract(hour from v_la)::int);
  end if;

  v_to   := v_la::date;
  v_from := v_to - 1;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb),
         count(*)::int,
         coalesce(sum(abs(r.diff_cents)), 0)::bigint
    into v_rows, v_count, v_abs
    from public.reconcile_staff_earnings(v_from, v_to) r;

  insert into public.earnings_reconciliation_log
    (from_date, to_date, discrepancy_count, total_abs_diff_cents, details)
  values (v_from, v_to, v_count, v_abs, v_rows);

  return jsonb_build_object('from_date', v_from, 'to_date', v_to,
                            'discrepancies', v_count,
                            'total_abs_diff_cents', v_abs,
                            'ran_at', now());
end;
$fn$;

comment on function public.nightly_reconcile_earnings(boolean) is
  'Reconciles yesterday and today, portal vs blueprint, into earnings_reconciliation_log. No-ops unless the LA hour is 21 (the job fires at 04:00 and 05:00 UTC to hold 9pm LA across DST); pass true to force a manual run.';

-- cron.schedule upserts by jobname, so re-running this migration re-points the
-- existing jobs rather than duplicating them.
select cron.schedule(
  'nightly-earnings-reconcile',
  '0 4,5 * * *',
  $$select public.nightly_reconcile_earnings();$$
);

-- Pruning 14-day-old history has no ordering constraint, so it moves to 9pm LA
-- with the rest of the evening work. 04:00 UTC only: an hour's DST drift is
-- meaningless for a 14-day cutoff, so it needs no gate.
select cron.schedule(
  'prune_daily_history_14d',
  '0 4 * * *',
  $$SELECT public.prune_daily_history_older_than_14d();$$
);
