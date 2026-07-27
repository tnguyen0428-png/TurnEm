-- Blocks deleting a completed_services row less than 7 days old unless the
-- deleting transaction explicitly opts in via `app.allow_clear = on`. Added
-- after an accidental-clear incident to make bulk/blanket deletes of recent
-- turn history impossible by accident — legitimate resets (the nightly
-- scheduled_morning_reset job, the admin_clear_day RPC) set that session
-- config for their own transaction before deleting.
--
-- NOTE: applied live via MCP on 2026-06-09; this file backfills the repo so
-- the migration history matches the database.

CREATE OR REPLACE FUNCTION public.guard_completed_services_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.completed_at IS NOT NULL
     AND OLD.completed_at > now() - interval '7 days'
     AND COALESCE(current_setting('app.allow_clear', true), '') <> 'on'
  THEN
    RAISE EXCEPTION
      'Clearing completed turns is disabled to prevent accidental data loss. Use admin_clear_day(passcode) to reset the day.';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS guard_completed_services_delete ON public.completed_services;
CREATE TRIGGER guard_completed_services_delete
BEFORE DELETE ON public.completed_services
FOR EACH ROW EXECUTE FUNCTION public.guard_completed_services_delete();

-- Sanctioned bypass: archives today's completed turns into daily_history,
-- then clears completed_services with the guard above disabled for just
-- this transaction. Callable by anon/authenticated so the app (or a staff
-- member via the Blueprint admin PIN) can trigger it directly.
--
-- Historical note: originally computed "today" in America/New_York instead
-- of America/Los_Angeles (inconsistent with the rest of the app) — fixed in
-- migration 20260726181934_fix_reset_functions_use_la_timezone.sql.
CREATE OR REPLACE FUNCTION public.admin_clear_day(p_passcode text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expected text;
  v_today    text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD');
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
