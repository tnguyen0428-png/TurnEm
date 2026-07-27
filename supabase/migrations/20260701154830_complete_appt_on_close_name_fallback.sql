-- Adds a fallback to complete_appointment_on_ticket_close: when a closed
-- ticket has no appointment_id / walk-in synth block link (the primary
-- match), fall back to an unambiguous client-name + date match against
-- today's scheduled/checked-in appointments. Only applies when exactly one
-- appointment matches, so it can't misfire onto the wrong client.
--
-- NOTE: applied live via MCP on 2026-07-01; this file backfills the repo so
-- the migration history matches the database.

CREATE OR REPLACE FUNCTION public.complete_appointment_on_ticket_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  affected int;
  match_count int;
  the_date text;
BEGIN
  IF NEW.status = 'closed'
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    the_date := to_char(NEW.business_date, 'YYYY-MM-DD');

    -- Primary: exact appointment_id link, or the visit's walk-in synth block.
    UPDATE public.appointments
    SET status = 'completed', last_edited_at = now()
    WHERE status IN ('scheduled', 'checked-in')
      AND (
        (NEW.appointment_id IS NOT NULL AND id = NEW.appointment_id)
        OR (
          NEW.queue_entry_id IS NOT NULL
          AND id LIKE 'walkin:' || NEW.queue_entry_id || '%'
          AND date = the_date
        )
      );
    GET DIAGNOSTICS affected = ROW_COUNT;

    -- Fallback: unambiguous client-name + date match when the link was lost.
    IF affected = 0
       AND NEW.client_name IS NOT NULL
       AND btrim(NEW.client_name) <> '' THEN
      SELECT count(*) INTO match_count
      FROM public.appointments
      WHERE status IN ('scheduled', 'checked-in')
        AND date = the_date
        AND lower(btrim(client_name)) = lower(btrim(NEW.client_name));

      IF match_count = 1 THEN
        UPDATE public.appointments
        SET status = 'completed', last_edited_at = now()
        WHERE status IN ('scheduled', 'checked-in')
          AND date = the_date
          AND lower(btrim(client_name)) = lower(btrim(NEW.client_name));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
