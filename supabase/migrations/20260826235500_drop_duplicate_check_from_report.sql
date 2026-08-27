-- Remove the [duplicate check] line from the 00:20 post-archive report.
--
-- Measured record: 5 hits in the 8 weeks to 2026-08-26, ZERO of them real.
-- Tony confirmed ticket #15 (Christine Ruiz) - the single case the detector was
-- built around - was legitimate: "hana did do both". A husband and wife (or any
-- pair) routinely book the same service with the same tech under ONE name, so
-- "same visit + same tech + same service twice" is normal salon work, not a
-- defect signature. This bug class has never actually been observed.
--
-- An alert that is wrong every time trains people to skim past the report, so
-- it costs more than it is worth.
--
-- detect_duplicate_visit_lines() is KEPT for ad-hoc use - call it directly if a
-- specific ticket is ever suspected of a double-bill. It is only unwired from
-- the nightly summary.
--
-- Reverts the job to the 20260826220000 version.

select cron.schedule(
  'postarchive-reconcile',
  '20 7,8 * * *',
  $cron$
do $do$
declare
  v_run bigint;
  v_j   jsonb;
begin
  if public.la_hour() <> 0 then return; end if;

  insert into public.nightly_run_report (business_date)
  values (((now() at time zone 'America/Los_Angeles')::date - 1))
  returning id into v_run;

  begin
    v_j := public.nightly_reconcile_earnings(true);
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'ok', v_j, null);
  exception when others then
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'error', null, sqlerrm);
  end;

  perform public.nightly_run_finish(v_run);

  update public.nightly_run_report
     set summary = replace(summary, 'TurnEm nightly ', 'TurnEm POST-ARCHIVE ')
   where id = v_run;
end
$do$;
  $cron$
);
