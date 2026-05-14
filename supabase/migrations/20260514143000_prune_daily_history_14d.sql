-- Auto-delete daily_history rows older than 14 days.
--
-- The staff mobile weekly-total view shows this week and last week (Sun–Sat).
-- Anything older than 14 days is unused; this nightly cron prunes it so the
-- table never grows unbounded.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.prune_daily_history_older_than_14d()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff text := to_char(CURRENT_DATE - INTERVAL '14 days', 'YYYY-MM-DD');
  removed integer;
BEGIN
  DELETE FROM public.daily_history WHERE date < cutoff;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'prune_daily_history_14d';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'prune_daily_history_14d',
  '30 2 * * *',
  $$SELECT public.prune_daily_history_older_than_14d();$$
);
