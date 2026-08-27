-- Post-archive reconcile pass.
--
-- WHY: the 23:30 chain runs reconcile -> prune -> archive -> board reset, so the
-- ONLY correctness check happens BEFORE the step that writes daily_history.
-- Anything the archive gets wrong is invisible to that night's report:
--   * TAMMY, 08/23: ticket $65, live board $65 at 23:30, archive wrote $55.
--     Nightly said "found 1, repaired 0" and never mentioned her.
--   * MACY, 08/25: nightly reported -$25; the archive then NULLed the price,
--     making the real gap -$65. Found by hand the next morning.
--
-- WHY A SEPARATE JOB, not another step in the chain: the archive is invoked with
-- net.http_post to the nightly-save-history edge function and recorded as
-- 'queued' — it is FIRE AND FORGET. The chain never waits for it. A reconcile
-- appended after that step would race the archive and could read the day before
-- it is written.
--
-- WHY 00:20 AND NOT 23:50: repair_staff_earnings branches on whether the target
-- date is today. For today it reprices the LIVE board — which the 23:30 board
-- reset has just cleared, so a same-night run does nothing useful. After
-- midnight the archived day is no longer "today", so repair takes its archive
-- branch and reads daily_history: exactly the data the archive just wrote.
--
-- nightly_reconcile_earnings() already covers [today-1, today], so at 00:20 that
-- window IS the archived day plus an empty new day. No new reconcile logic.
--
-- Deliberately does NOT push. The 23:30 chain pushes; a second notification at
-- 00:20 would wake people for something that is read in the morning.
--
-- Additive: cron job 3 (nightly-save-history) is untouched.

select cron.schedule(
  'postarchive-reconcile',
  -- LA 00:20 is 07:20 UTC in PDT and 08:20 UTC in PST. Schedule both and gate on
  -- the LA hour, mirroring how nightly-save-history handles DST.
  '20 7,8 * * *',
  $cron$
do $do$
declare
  v_run bigint;
  v_j   jsonb;
begin
  if public.la_hour() <> 0 then return; end if;

  -- Label the report with the day being CHECKED (yesterday), not the clock date,
  -- so it lines up with the 23:30 run for the same business date.
  insert into public.nightly_run_report (business_date)
  values (((now() at time zone 'America/Los_Angeles')::date - 1))
  returning id into v_run;

  begin
    -- Step name 'reconcile_repair' is what nightly_run_finish knows how to
    -- format (found / repaired / still off, plus the STILL OFF detail lines).
    v_j := public.nightly_reconcile_earnings(true);
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'ok', v_j, null);
  exception when others then
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'error', null, sqlerrm);
  end;

  perform public.nightly_run_finish(v_run);

  -- Distinguish this row from the 23:30 run for the same business_date.
  update public.nightly_run_report
     set summary = replace(summary, 'TurnEm nightly ', 'TurnEm POST-ARCHIVE ')
   where id = v_run;
end
$do$;
  $cron$
);
