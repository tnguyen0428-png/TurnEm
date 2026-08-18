-- scheduled_morning_reset() archived completed_services and cleared
-- completed_services/queue_entries, but never touched the manicurists
-- table. The client's DAILY_RESET reducer action does that reset
-- (clockedIn/clockInTime/totalTurns/etc back to defaults), but it only
-- fires when a browser tab is open during the LA rollover window. This
-- pg_cron job runs unattended every night regardless, so when no tab was
-- open, yesterday's clock_in_time survived into the new day and the
-- History screen's "Turns per Manicurist" list (which includes any
-- manicurist with a non-null clock_in_time) showed yesterday's roster
-- before anyone had clocked in today. Add the manicurist reset here so
-- the unattended path does the full job, mirroring the client reducer.
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
  -- entries are built with an explicit ORDER BY manicurist_clock_in_time
  -- (nulls last) inside jsonb_agg -- without it Postgres gives no order
  -- guarantee at all, which is why "Turns per Manicurist" kept reshuffling
  -- every night even after manicurist_clock_in_time was added to
  -- completed_services: this function runs last (after nightly-save-history)
  -- and overwrites daily_history.entries wholesale, so an unordered rebuild
  -- here silently undid any correctly-ordered save from earlier in the
  -- pipeline. manicuristClockInTime is now included in each entry too, so a
  -- past-day History view has the same durable stamp the client relies on.
  FOR v_rec IN
    SELECT to_char((completed_at AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM-DD') AS d,
           jsonb_agg(jsonb_build_object(
             'id', id, 'clientName', client_name, 'services', to_jsonb(services),
             'turnValue', turn_value, 'manicuristId', manicurist_id,
             'manicuristName', manicurist_name, 'manicuristColor', manicurist_color,
             'startedAt',   (extract(epoch from started_at)*1000)::bigint,
             'completedAt', (extract(epoch from completed_at)*1000)::bigint,
             'manicuristClockInTime',
               CASE WHEN manicurist_clock_in_time IS NULL THEN NULL
                    ELSE (extract(epoch from manicurist_clock_in_time)*1000)::bigint END,
             -- Added 2026-08-13. Previously dropped; see header note.
             'priceCents', price_cents,
             'voided', COALESCE(voided, false),
             'edited', COALESCE(edited, false),
             'isAppointment', COALESCE(is_appointment, false),
             'isRequested', COALESCE(is_requested, false),
             'requestedServices',
               CASE WHEN requested_services IS NULL THEN NULL
                    ELSE to_jsonb(requested_services) END)
             ORDER BY manicurist_clock_in_time NULLS LAST, completed_at) AS entries
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

  -- Reset every manicurist for the new day. This job runs unattended via
  -- pg_cron regardless of whether a browser tab is open; the client's
  -- DAILY_RESET reducer action performs the equivalent reset but only fires
  -- when a tab is open during the LA rollover window. Without this, stale
  -- clock_in_time from the prior day survived into the new day and the
  -- History screen's "Turns per Manicurist" list (which includes any
  -- manicurist with a non-null clock_in_time) showed yesterday's roster
  -- before anyone had clocked in today.
  UPDATE manicurists
     SET clocked_in = false,
         clock_in_time = null,
         total_turns = 0,
         current_client_id = null,
         status = 'available',
         has_fourth_position_special = false,
         has_check2 = false,
         has_check3 = false,
         has_wax = false,
         has_wax2 = false,
         has_wax3 = false;

  UPDATE system_state
     SET last_archive_date = (now() AT TIME ZONE 'America/Los_Angeles')::date,
         updated_at = now()
   WHERE id = 'singleton';

  RETURN jsonb_build_object('cleared', v_total, 'archived_dates', v_dates,
                            'ran_at', now());
END;
$function$;
