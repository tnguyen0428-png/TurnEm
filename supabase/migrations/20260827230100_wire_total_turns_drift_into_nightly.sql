-- Wire detect_total_turns_drift() into the 23:30 chain, positioned BEFORE the
-- board reset — like lost_request_check, it reads the LIVE board, which the
-- reset clears.
--
-- With migration 20260827230000 in place the database is the only writer of
-- total_turns, so this should never fire. That is the point: it is a regression
-- alarm for a second writer reappearing, not a repair. Turn values feed queue
-- ORDER, so nothing here auto-corrects — see feedback on turns order.
--
-- APPLY THE SAME WAY AS 20260826234900 (string replacement on the stored cron
-- command, using the board-reset block as the anchor). Verify the anchor still
-- has exactly ONE occurrence before replacing, and do it immediately AFTER a
-- 23:30 run completes so there is a full day before it next fires:
--
--   select cron.schedule('nightly-save-history', schedule,
--     replace(command, '<board reset begin block>', '<new step> || <same block>'))
--   from cron.job where jobname = 'nightly-save-history';
--
-- The effective step to insert ahead of the board reset:
--
--   begin
--     perform public.nightly_run_step(v_run, 'turn_total_drift',
--       coalesce((select format('FOUND %s - %s', count(*),
--                        string_agg(format('%s: stored %s vs %s', d.manicurist_name, d.stored, d.expected), '; '))
--                 from public.detect_total_turns_drift() d
--                 having count(*) > 0), 'ok'),
--       null, null);
--   exception when others then
--     perform public.nightly_run_step(v_run, 'turn_total_drift', 'error', null, sqlerrm);
--   end;
--
-- No new variables are declared and `having count(*) > 0` returns NO ROW when
-- clean, so coalesce falls through to 'ok'. nightly_run_finish has no bespoke
-- formatter for this step name, so it prints via the generic branch as
-- `[HH:MM:SS] turn_total_drift ok`. That is intentional.
--
-- This file documents the change for schema history; apply the live job update
-- at deploy time and confirm with the check below.

do $$
begin
  if not exists (
    select 1 from cron.job
    where jobname = 'nightly-save-history'
      and command ilike '%detect_total_turns_drift%'
  ) then
    raise notice 'turn_total_drift is NOT wired into nightly-save-history - apply by hand at deploy';
  end if;
end $$;
