-- Fold the board reset into the 11:30 PM LA chain. Confirmed 2026-08-18: the
-- salon closes by 11 PM, so nothing is completed after the chain runs and the
-- reset can safely clear the board on the same pass that archives it.
--
-- Final order, one command, one transaction:
--   1. reconcile + repair to the blueprint receipts
--   2. prune daily_history beyond 30 LA days
--   3. queue the archive edge function (pg_net)
--   4. scheduled_morning_reset: archive per LA date, then clear
--      completed_services, queue_entries and manicurists
--
-- Two consequences, both deliberate:
--
-- * Step 3 is asynchronous -- pg_net dispatches after COMMIT -- so step 4
--   always wins the race and the edge function finds an empty
--   completed_services. Its archive path becomes a no-op on a normal night
--   (it skips the upsert rather than writing an empty row) and it runs purely
--   as a purge. That costs nothing: the reset already archives every LA date
--   with the same 16-field entry shape, and being a blind ON CONFLICT DO
--   UPDATE it was overwriting the edge function's merge at 2 AM anyway. The
--   day's end state is exactly what it was before, just earlier.
--
-- * All four steps now share one transaction, so a failure in any of them
--   rolls back the rest, including the queued archive. That is the trade for
--   guaranteed ordering. Failures surface in cron.job_run_details.
--
-- The command is rebuilt FROM the existing one so the inline service-role
-- bearer token is never written into this file or into git.
do $mig$
declare
  v_cmd  text;
  v_post text;
begin
  select command into v_cmd from cron.job where jobname = 'nightly-save-history';

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
    perform public.scheduled_morning_reset();
  end if;
end
$do$;
$cmd$, v_post));
end
$mig$;

-- Now the last step of the chain above.
do $u$ begin perform cron.unschedule('morning-board-reset'); exception when others then null; end $u$;
