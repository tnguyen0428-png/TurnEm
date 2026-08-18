-- Rewire the 11:30 PM LA chain to report every step.
--
-- Each step now runs in its own exception block, so:
--   * a failure is RECORDED rather than rolling back the whole night, and
--   * one broken step no longer discards the work the others completed.
--
-- Step order is unchanged: reconcile+repair, prune, archive, board reset.
-- nightly_reconcile_earnings is called with p_force because the LA-hour gate
-- is already applied once at the top of the command.
--
-- The command is rebuilt FROM the existing one so the inline service-role
-- bearer token is never written into this file or into git.
do $mig$
declare
  v_cmd  text;
  v_post text;
begin
  select command into v_cmd from cron.job where jobname = 'nightly-save-history';

  v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*?)\)\s*;\s*perform\s+public\.scheduled_morning_reset'))[1];
  if v_post is null then
    v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*)\)\s*;\s*end\s+if'))[1];
  end if;
  if v_post is null then
    v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*)\)\s*;?\s*$'))[1];
  end if;

  if v_post is null then
    raise exception 'could not extract the net.http_post call from nightly-save-history; aborting rather than clobbering it';
  end if;

  perform cron.schedule('nightly-save-history', '30 6,7 * * *', format($cmd$
do $do$
declare
  v_run bigint;
  v_j   jsonb;
  v_i   int;
  v_b   bigint;
begin
  if public.la_hour() <> 23 then return; end if;

  v_run := public.nightly_run_begin();

  begin
    v_j := public.nightly_reconcile_earnings(true);
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'ok', v_j, null);
  exception when others then
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'error', null, sqlerrm);
  end;

  begin
    v_i := public.prune_daily_history(30);
    perform public.nightly_run_step(v_run, 'prune_history', 'ok', jsonb_build_object('rows_deleted', v_i), null);
  exception when others then
    perform public.nightly_run_step(v_run, 'prune_history', 'error', null, sqlerrm);
  end;

  begin
    v_b := net.http_post(%s);
    perform public.nightly_run_step(v_run, 'archive_edge_fn', 'queued', jsonb_build_object('request_id', v_b), null);
  exception when others then
    perform public.nightly_run_step(v_run, 'archive_edge_fn', 'error', null, sqlerrm);
  end;

  begin
    v_j := public.scheduled_morning_reset();
    perform public.nightly_run_step(v_run, 'board_reset', 'ok', v_j, null);
  exception when others then
    perform public.nightly_run_step(v_run, 'board_reset', 'error', null, sqlerrm);
  end;

  perform public.nightly_run_finish(v_run);
end
$do$;
$cmd$, v_post));
end
$mig$;
