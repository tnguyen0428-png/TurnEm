-- Extend the "darken paid appointment" trigger to cover SPLIT walk-in visits.
--
-- Background: 2026-06-02 we added complete_appointment_on_ticket_close() so a
-- closed ticket flips its linked appointment (by appointment_id) to
-- 'completed', darkening it in the book on all devices. That handled the common
-- 1-appointment-per-visit case.
--
-- Residual case (Cindy/Joe, 2026-06-03): one walk-in visit split across two
-- manicurists creates TWO appointment rows that share a visit root
-- (id = 'walkin:' || <queue_entry_id> || '<suffix>'), e.g. HANA's '...-mani-8'
-- and JOE's '...-waiting'. The ticket carries only ONE appointment_id, so only
-- that row darkened; the sibling stayed 'checked-in' (light gray) after payment.
--
-- Fix: on close, also flip same-visit walk-in sibling rows, matched by the
-- visit root and constrained to the ticket's business_date + still-active
-- statuses (so we never touch a different day's booking for a repeat walk-in,
-- or a cancelled/no-show row).
CREATE OR REPLACE FUNCTION public.complete_appointment_on_ticket_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'closed'
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.appointments
    SET status = 'completed', last_edited_at = now()
    WHERE status IN ('scheduled', 'checked-in')
      AND (
        (NEW.appointment_id IS NOT NULL AND id = NEW.appointment_id)
        OR (
          NEW.queue_entry_id IS NOT NULL
          AND id LIKE 'walkin:' || NEW.queue_entry_id || '%'
          AND date = NEW.business_date
        )
      );
  END IF;
  RETURN NEW;
END;
$function$;
