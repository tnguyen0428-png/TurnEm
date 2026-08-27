-- Wire detect_lost_request_credit() into the 23:30 chain, as a step that runs
-- BEFORE the board reset - it reads the LIVE completed_services board, which the
-- reset clears.
--
-- Applied by string replacement on the STORED cron command rather than retyping
-- the chain, using the board-reset block as a unique anchor (verified: exactly 1
-- occurrence). Verified afterwards: detector present, positioned before
-- scheduled_morning_reset, and all five original steps (reconcile_repair,
-- prune_history, archive_edge_fn, board_reset, push_report) still intact.
-- Length 2479 -> 2964. Done immediately AFTER the 2026-08-26 23:30 run
-- completed, giving a full day before it next fires.
--
--   select cron.schedule('nightly-save-history', schedule,
--     replace(command, '<board reset begin block>', '<new step> || <same block>'))
--   from cron.job where jobname = 'nightly-save-history';
--
-- No new variables are declared: the detail string is built inline, and
-- `having count(*) > 0` returns NO ROW when clean so coalesce falls through to
-- 'ok'. Both branches were executed before wiring:
--   clean     -> 'ok'
--   with hits -> 'FOUND 2 - Nancy/TOMMY (Pedicure); Sue Krikorian/TOMMY (...)'
--
-- nightly_run_finish has no bespoke formatter for this step name, so it prints
-- via the generic branch as `[HH:MM:SS] lost_request_check FOUND ...` (status is
-- upper-cased). That is intentional - the shared summary builder is left alone.
--
-- The step is wrapped in its own begin/exception like every other step, so a
-- failure is logged as a step error and the chain continues to archive+reset.

-- The effective step inserted ahead of the board reset:
--
--   begin
--     perform public.nightly_run_step(v_run, 'lost_request_check',
--       coalesce((select format('FOUND %s - %s', count(*),
--                        string_agg(format('%s/%s (%s)', d.client_name, d.staff_name, d.booked_as), '; '))
--                 from public.detect_lost_request_credit() d
--                 having count(*) > 0), 'ok'),
--       null, null);
--   exception when others then
--     perform public.nightly_run_step(v_run, 'lost_request_check', 'error', null, sqlerrm);
--   end;
--
-- This file documents the change for schema history; the live job was updated
-- at the same time.

do $$
begin
  if not exists (
    select 1 from cron.job
    where jobname = 'nightly-save-history'
      and command ilike '%detect_lost_request_credit%'
  ) then
    raise notice 'lost_request_check is NOT wired into nightly-save-history - re-apply by hand';
  end if;
end $$;
