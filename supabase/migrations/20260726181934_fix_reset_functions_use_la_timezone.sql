-- scheduled_morning_reset and admin_clear_day both computed "today's date"
-- using America/New_York instead of America/Los_Angeles, inconsistent with
-- every other date computation in the app (getTodayLA(), nightly-save-history
-- edge function). Harmless today only because the cron fires at a fixed UTC
-- hour that happens to land on the same calendar date in both zones; fixing
-- for correctness so it can't silently misfile an archive date if the
-- schedule ever changes.

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
     SET last_archive_date = (now() AT TIME ZONE 'America/Los_Angeles')::date,
         updated_at = now()
   WHERE id = 'singleton';

  RETURN jsonb_build_object('cleared', v_total, 'archived_dates', v_dates,
                            'ran_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_clear_day(p_passcode text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expected text;
  v_today    text := to_char((now() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD');
  v_entries  jsonb;
  v_count    int;
BEGIN
  SELECT admin_passcode INTO v_expected FROM system_state WHERE id = 'singleton';
  IF p_passcode IS NULL OR p_passcode IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Invalid passcode';
  END IF;

  -- Snapshot today's completed turns into daily_history (merge by id, fresh wins).
  SELECT jsonb_agg(jsonb_build_object(
           'id', id, 'clientName', client_name, 'services', to_jsonb(services),
           'turnValue', turn_value, 'manicuristId', manicurist_id,
           'manicuristName', manicurist_name, 'manicuristColor', manicurist_color,
           'startedAt', (extract(epoch from started_at)*1000)::bigint,
           'completedAt', (extract(epoch from completed_at)*1000)::bigint
         ))
    INTO v_entries
    FROM completed_services
   WHERE completed_at IS NOT NULL;

  IF v_entries IS NOT NULL THEN
    INSERT INTO daily_history (id, date, entries)
    VALUES (gen_random_uuid()::text, v_today, v_entries)
    ON CONFLICT (date) DO UPDATE SET entries = EXCLUDED.entries;
  END IF;

  -- Allow deletes past the guard, only for this transaction.
  PERFORM set_config('app.allow_clear', 'on', true);
  WITH del AS (DELETE FROM completed_services RETURNING 1)
  SELECT count(*) INTO v_count FROM del;

  RETURN v_count;
END;
$function$;
