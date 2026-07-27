-- Server-side nightly reset, independent of any client being open. Archives
-- today's completed turns into daily_history (one row per LA date), clears
-- completed_services and queue_entries past the delete guard for its own
-- transaction, and stamps system_state.last_archive_date so client startup
-- checks know the reset already ran. Scheduled via pg_cron.
--
-- Historical note: originally stamped last_archive_date using
-- America/New_York instead of America/Los_Angeles (inconsistent with the
-- rest of the app) — fixed in migration
-- 20260726181934_fix_reset_functions_use_la_timezone.sql.
--
-- NOTE: applied live via MCP on 2026-06-09; this file backfills the repo so
-- the migration history matches the database.

CREATE OR REPLACE FUNCTION public.scheduled_morning_reset()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rec   record;
  v_total int := 0;
  v_dates int := 0;
BEGIN
  -- Archive current completed turns, one daily_history row per LA date.
  FOR v_rec IN
    SELECT to_char((completed_at AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM-DD') AS d,
           jsonb_agg(jsonb_build_object(
             'id', id, 'clientName', client_name, 'services', to_jsonb(services),
             'turnValue', turn_value, 'manicuristId', manicurist_id,
             'manicuristName', manicurist_name, 'manicuristColor', manicurist_color,
             'startedAt',   (extract(epoch from started_at)*1000)::bigint,
             'completedAt', (extract(epoch from completed_at)*1000)::bigint)) AS entries
    FROM completed_services
    WHERE completed_at IS NOT NULL
    GROUP BY 1
  LOOP
    INSERT INTO daily_history (id, date, entries)
    VALUES (gen_random_uuid()::text, v_rec.d, v_rec.entries)
    ON CONFLICT (date) DO UPDATE SET entries = EXCLUDED.entries;
    v_dates := v_dates + 1;
  END LOOP;

  -- Clear the board (allowed past the guard for this transaction only).
  PERFORM set_config('app.allow_clear','on',true);
  WITH del AS (DELETE FROM completed_services WHERE completed_at IS NOT NULL RETURNING 1)
  SELECT count(*) INTO v_total FROM del;

  -- Clear any leftover queue entries so the new day starts clean.
  DELETE FROM queue_entries;

  UPDATE system_state
     SET last_archive_date = (now() AT TIME ZONE 'America/New_York')::date,
         updated_at = now()
   WHERE id = 'singleton';

  RETURN jsonb_build_object('cleared', v_total, 'archived_dates', v_dates,
                            'ran_at', now());
END;
$function$;

SELECT cron.schedule(
  'morning-board-reset',
  '0 9 * * *',
  $$SELECT public.scheduled_morning_reset();$$
);
