-- Applied live to the TurnEM Salon project on 2026-08-13.
--
-- scheduled_morning_reset() rebuilds daily_history.entries from
-- completed_services and, running ~2h AFTER nightly-save-history, overwrites
-- that row wholesale -- so it is the LAST writer and its field list decides
-- what the archive actually keeps.
--
-- It was building each entry from only 10 fields, dropping priceCents, voided,
-- edited, isAppointment, isRequested and requestedServices. Measured impact:
-- priceCents was absent from 100% of 1134 archived entries, so the staff portal
-- fell through to CATALOG list price on every past day and understated staff
-- earnings by ~$2.6k across 8/02-8/08 alone -- every tech low, never high,
-- because upcharges are invisible to the catalog (Gel Fill lists $40 but
-- averaged $51.83 actually charged). Dropping `voided` also made voided rows
-- read back as undefined/falsy, counting them as real turns.
--
-- Keep this field list in sync with mapDbCompleted() in
-- src/state/AppContext.tsx and the CompletedEntry mapping in
-- supabase/functions/nightly-save-history/index.ts. All three write this shape;
-- a field missing from ANY of them is erased by whichever runs last.
--
-- NOTE (not changed here): the ON CONFLICT below is still a wholesale replace,
-- so an entry present in daily_history but absent from completed_services is
-- dropped on rebuild. That is what makes manual repairs to daily_history
-- fragile. Left as-is deliberately -- changing overwrite->merge needs its own
-- decision about which copy wins.
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

  PERFORM set_config('app.allow_clear','on',true);
  WITH del AS (DELETE FROM completed_services WHERE completed_at IS NOT NULL RETURNING 1)
  SELECT count(*) INTO v_total FROM del;

  DELETE FROM queue_entries;

  UPDATE system_state
     SET last_archive_date = (now() AT TIME ZONE 'America/Los_Angeles')::date,
         updated_at = now()
   WHERE id = 'singleton';

  RETURN jsonb_build_object('cleared', v_total, 'archived_dates', v_dates,
                            'ran_at', now());
END;
$function$;
