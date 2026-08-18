-- Three changes, requested 2026-08-18:
--   1. Retention 10 days -> 30 days.
--   2. Every nightly task runs at 11:30 PM LA, in one ordered chain.
--   3. The reconciliation now REPAIRS toward the blueprint, because the ticket
--      receipt is the accurate record of what the client paid.

-- 1. Retention: 30 days. Replaces prune_daily_history_older_than_14d, whose
-- name no longer matches the policy. The edge function's HISTORY_RETENTION_DAYS
-- and COMPLETED_RETENTION_DAYS moved 10 -> 30 in the same change; the edge
-- function is the binding constraint, so both had to move or nothing would.
create or replace function public.prune_daily_history(p_days int default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff  text := to_char(((now() at time zone 'America/Los_Angeles')::date - make_interval(days => p_days)), 'YYYY-MM-DD');
  removed integer;
begin
  delete from public.daily_history where date < cutoff;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.prune_daily_history(int) is
  'Deletes daily_history older than p_days LA days (default 30). Cutoff is anchored to the LA date, not CURRENT_DATE, because every run happens after 5pm LA when the UTC date is already tomorrow.';

drop function if exists public.prune_daily_history_older_than_14d();

-- 3. Repair toward the blueprint.
alter table public.earnings_reconciliation_log
  add column if not exists discrepancies_before int    not null default 0,
  add column if not exists repaired_count       int    not null default 0,
  add column if not exists repairs              jsonb  not null default '[]'::jsonb;

comment on column public.earnings_reconciliation_log.discrepancies_before is
  'Disagreeing (date, tech) pairs found BEFORE the repair pass ran.';
comment on column public.earnings_reconciliation_log.discrepancy_count is
  'Disagreeing pairs REMAINING after the repair pass. Non-zero means the repair could not prove the fix and a human should look.';

-- Reconcile, repair to the receipts, reconcile again. The second reconcile is
-- what gets logged as discrepancy_count, so the log answers the question that
-- matters in the morning: what is still wrong, having fixed what we safely can.
--
-- repair_staff_earnings only rewrites an entry when that tech's own lines
-- account for the ENTIRE (visit, tech) bucket. That guard is deliberate: a dry
-- run without it would have reverted LY's hand-consolidated Lani entry from the
-- correct $105 to $55. Anything it cannot prove stays in details, unrepaired,
-- for a human -- the portal is never made to disagree with the blueprint in the
-- name of fixing it.
create or replace function public.nightly_reconcile_earnings(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_la      timestamp := now() at time zone 'America/Los_Angeles';
  v_to      date;
  v_from    date;
  v_before  jsonb;  v_before_n int;  v_before_abs bigint;
  v_repairs jsonb;  v_repair_n int;
  v_after   jsonb;  v_after_n  int;  v_after_abs  bigint;
begin
  -- 11:30 PM LA. The job fires at 06:30 and 07:30 UTC so one firing always
  -- lands on 23:xx LA whichever side of DST we are on; this gate drops the other.
  if not p_force and public.la_hour() <> 23 then
    return jsonb_build_object('skipped', true, 'la_hour', public.la_hour());
  end if;

  v_to   := v_la::date;
  v_from := v_to - 1;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb), count(*)::int,
         coalesce(sum(abs(r.diff_cents)), 0)::bigint
    into v_before, v_before_n, v_before_abs
    from public.reconcile_staff_earnings(v_from, v_to) r;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb), count(*)::int
    into v_repairs, v_repair_n
    from public.repair_staff_earnings(v_from, v_to) x;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb), count(*)::int,
         coalesce(sum(abs(r.diff_cents)), 0)::bigint
    into v_after, v_after_n, v_after_abs
    from public.reconcile_staff_earnings(v_from, v_to) r;

  insert into public.earnings_reconciliation_log
    (from_date, to_date, discrepancies_before, repaired_count, repairs,
     discrepancy_count, total_abs_diff_cents, details)
  values (v_from, v_to, v_before_n, v_repair_n, v_repairs,
          v_after_n, v_after_abs, v_after);

  return jsonb_build_object('from_date', v_from, 'to_date', v_to,
                            'found', v_before_n, 'repaired', v_repair_n,
                            'remaining', v_after_n,
                            'remaining_abs_cents', v_after_abs,
                            'ran_at', now());
end;
$fn$;

comment on function public.nightly_reconcile_earnings(boolean) is
  'Nightly: reconcile portal vs blueprint for yesterday and today, repair what the ticket receipts prove, reconcile again, and log all three. No-ops unless the LA hour is 23; pass true to force a manual run.';

-- 2. One chain, 11:30 PM LA. Order matters and is guaranteed by running in one
-- command: repair first so the archive captures corrected prices, prune second,
-- archive last. The archive is a pg_net call, queued and dispatched after this
-- transaction commits, so it cannot overtake the repair.
--
-- The command is rebuilt FROM the existing one: it carries a service-role
-- bearer token inline, which is therefore never written into this file or into
-- git. (Still plaintext in cron.job.command -- worth rotating into Vault.)
do $mig$
declare
  v_cmd  text;
  v_post text;
begin
  select command into v_cmd from cron.job where jobname = 'nightly-save-history';

  -- Two shapes are possible: the original bare "SELECT net.http_post(...);"
  -- and the DST-gated "do $do$ ... perform net.http_post(...); end if; end".
  v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*)\)\s*;\s*end\s+if'))[1];
  if v_post is null then
    v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*)\)\s*;?\s*$'))[1];
  end if;

  if v_post is null then
    raise exception 'could not extract the net.http_post call from nightly-save-history; aborting rather than clobbering it';
  end if;

  perform cron.schedule('nightly-save-history', '30 6,7 * * *', format($cmd$
do $do$
begin
  if public.la_hour() = 23 then
    perform public.nightly_reconcile_earnings();
    perform public.prune_daily_history(30);
    perform net.http_post(%s);
  end if;
end
$do$;
$cmd$, v_post));
end
$mig$;

-- Folded into the chain above; they no longer run on their own.
do $u$ begin perform cron.unschedule('nightly-earnings-reconcile'); exception when others then null; end $u$;
do $u$ begin perform cron.unschedule('prune_daily_history_14d');   exception when others then null; end $u$;

-- morning-board-reset deliberately stays at 2:00 AM LA. It archives with a
-- blind ON CONFLICT DO UPDATE and then clears completed_services,
-- queue_entries and manicurists; moved to 11:30 PM it would race the archive
-- in the same minute and, for any turn completed after it ran, let the NEXT
-- night's reset overwrite this day's full archive with just those few rows.
