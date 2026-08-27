-- Retention for archived earnings history: 30 -> 90 days.
--
-- The 23:30 chain called prune_daily_history(30), so a tech's own earnings
-- history vanished after a month. Tony asked for 90 on 2026-08-26.
--
-- The cron job was edited by string replacement on the STORED command rather
-- than retyping it, so nothing else in the chain could be altered: verified
-- exactly one occurrence of the substring, identical command length before and
-- after (2479), and all four other steps (reconcile_repair, archive_edge_fn,
-- board_reset, push_report) still present afterwards. Done 50 minutes before
-- that night's 23:30 run, which is why the no-retyping approach mattered.
--
--   select cron.schedule('nightly-save-history', schedule,
--          replace(command, 'prune_daily_history(30)', 'prune_daily_history(90)'))
--   from cron.job where jobname = 'nightly-save-history';
--
-- NOTE: this does NOT bring back already-pruned days. daily_history currently
-- starts at 2026-08-07; 08/05 and 08/06 are missing and were NOT lost to the
-- prune (its cutoff was 2026-07-27) - cause still unknown.

create or replace function public.prune_daily_history(p_days integer default 90)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  cutoff  text := to_char(((now() at time zone 'America/Los_Angeles')::date - make_interval(days => p_days)), 'YYYY-MM-DD');
  removed integer;
begin
  delete from public.daily_history where date < cutoff;
  get diagnostics removed = row_count;
  return removed;
end;
$function$;
