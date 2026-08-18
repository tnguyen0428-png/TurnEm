-- Send the nightly report to the owner's phone as a web push, using the same
-- send-push path the staff service alerts use.
--
-- send-push runs with verify_jwt = true, so the call needs a bearer token. The
-- Authorization header is EXTRACTED from the existing cron command rather than
-- retyped, so no credential is written into this file or into git, and no new
-- place to store one is created.
--
-- The push goes out after the first nightly_run_finish (which is what renders
-- the report the push summarises), then finish runs a second time so the
-- report itself records whether the push was queued or failed.
do $mig$
declare
  v_cmd  text;
  v_post text;
  v_hdrs text;
begin
  select command into v_cmd from cron.job where jobname = 'nightly-save-history';

  v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*?)\)\s*;\s*perform\s+public\.nightly_run_step\s*\(\s*v_run\s*,\s*''archive_edge_fn'''))[1];
  if v_post is null then
    v_post := (regexp_match(v_cmd, 'net\.http_post\s*\((.*?)\)\s*;\s*perform'))[1];
  end if;
  v_hdrs := (regexp_match(v_cmd, 'headers\s*:=\s*(jsonb_build_object\([^)]*\))'))[1];

  if v_post is null or v_hdrs is null then
    raise exception 'could not extract the http_post call or its headers; aborting rather than clobbering the job';
  end if;

  perform cron.schedule('nightly-save-history', '30 6,7 * * *', format($cmd$
do $do$
declare
  v_run bigint;
  v_j   jsonb;
  v_p   jsonb;
  v_r   record;
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
    v_b := net.http_post(%1$s);
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

  begin
    v_p := public.nightly_push_body();
    for v_r in select push_id from public.report_push_recipients where active loop
      perform net.http_post(
        url     := 'https://cpgiqgyfoqlczpvbwfic.supabase.co/functions/v1/send-push',
        headers := %2$s,
        body    := jsonb_build_object('manicuristId', v_r.push_id,
                                      'title', v_p->>'title',
                                      'body',  v_p->>'body'));
    end loop;
    perform public.nightly_run_step(v_run, 'push_report', 'queued', v_p, null);
  exception when others then
    perform public.nightly_run_step(v_run, 'push_report', 'error', null, sqlerrm);
  end;

  perform public.nightly_run_finish(v_run);
end
$do$;
$cmd$, v_post, v_hdrs));
end
$mig$;
