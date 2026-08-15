-- Darken the blocks for the work actually ON the ticket, not only the work
-- implied by the ticket's header visit.
--
-- findOpenTicketForClient matches an open ticket by phone-then-name with NO
-- visit check, so a client's second visit of the day appends its lines to the
-- first visit's still-open ticket. The header keeps visit A while the lines
-- carry visit B. 45 of the 47 mismatched tickets in the entire history belong
-- to a client with more than one ticket that day, which is the mechanism.
-- (Ticket #23, 2026-08-13: header 895e5373, lines d5fb2605.)
--
-- The previous version matched `walkin:' || NEW.queue_entry_id || '%'` - the
-- header only - so the second visit's blocks stayed light after the ticket was
-- closed and paid. Measured across five real mismatched tickets from June to
-- August: the header visit had 0 blocks every time, the lines' visit had 1-3.
--
-- Deliberately unchanged: the appointment_id link, the status filter, and the
-- single-name fallback. This only widens which walk-in visits are considered.
-- Whether a second visit SHOULD share one bill is a business decision and is
-- not touched here.
create or replace function complete_appointment_on_ticket_close()
returns trigger
language plpgsql
as $$
DECLARE
  affected int;
  match_count int;
  the_date text;
BEGIN
  IF NEW.status = 'closed'
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    the_date := to_char(NEW.business_date, 'YYYY-MM-DD');

    UPDATE public.appointments a
    SET status = 'completed', last_edited_at = now()
    WHERE a.status IN ('scheduled', 'checked-in')
      AND (
        (NEW.appointment_id IS NOT NULL AND a.id = NEW.appointment_id)
        OR (
          NEW.queue_entry_id IS NOT NULL
          AND a.id LIKE 'walkin:' || NEW.queue_entry_id || '%'
          AND a.date = the_date
        )
        OR (
          a.date = the_date
          AND EXISTS (
            SELECT 1 FROM public.ticket_items ti
            WHERE ti.ticket_id = NEW.id
              AND ti.queue_entry_id IS NOT NULL
              AND a.id LIKE 'walkin:' ||
                    substring(split_part(ti.queue_entry_id, '#', 1)
                              from '^[0-9a-f-]{36}') || '%'
          )
        )
      );
    GET DIAGNOSTICS affected = ROW_COUNT;

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
$$;
