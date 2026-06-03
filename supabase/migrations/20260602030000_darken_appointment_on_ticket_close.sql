-- When a ticket closes, mark its linked appointment 'completed' so the book
-- darkens the EXACT block (by appointment id, never by name). Server-side, so it
-- works regardless of which device closed the ticket or whether that device had
-- the appointment loaded -- this is what was failing before (the client darken
-- relied on a one-time, same-device name match that could miss, e.g. Jone
-- Coleman 2026-06-02). Keyed by id, so two same-name/same-tech bookings
-- (mother + daughter) each darken only their own block.
--
-- Requires tickets.appointment_id to be populated; the client now backfills it
-- continuously during the visit (backfillTicketAppointment in src/lib/tickets.ts)
-- so it's reliably present by close.

CREATE OR REPLACE FUNCTION public.complete_appointment_on_ticket_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'closed'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.appointment_id IS NOT NULL THEN
    UPDATE public.appointments
    SET status = 'completed', last_edited_at = now()
    WHERE id = NEW.appointment_id
      AND status IN ('scheduled', 'checked-in');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tickets_complete_appointment_on_close ON public.tickets;
CREATE TRIGGER tickets_complete_appointment_on_close
  AFTER UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.complete_appointment_on_ticket_close();
