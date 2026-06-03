-- Observability for the "existing appointment disappeared" reports. The client
-- infers deletions from an in-memory state diff (AppContext.tsx ~941) and issues
-- a real DB DELETE; a sync/realtime race can delete a still-valid appointment.
-- This AFTER DELETE trigger records every removed appointment so the next
-- disappearance is captured with full detail. A booked row (is_walk_in=false,
-- status='scheduled') showing up here is the bug signature; walk-in churn /
-- revert-to-queue deletes are expected noise.

CREATE TABLE IF NOT EXISTS public.appointment_delete_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deleted_at    timestamptz NOT NULL DEFAULT now(),
  appt_id       text,
  client_name   text,
  service       text,
  services      jsonb,
  manicurist_id text,
  date          text,
  "time"        text,
  status        text,
  is_walk_in    boolean,
  created_at    timestamptz
);

CREATE OR REPLACE FUNCTION public.log_appointment_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.appointment_delete_log(
    appt_id, client_name, service, services, manicurist_id, date, "time", status, is_walk_in, created_at)
  VALUES (
    OLD.id, OLD.client_name, OLD.service, OLD.services, OLD.manicurist_id,
    OLD.date, OLD."time", OLD.status, OLD.is_walk_in, OLD.created_at);
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS appointments_log_delete ON public.appointments;
CREATE TRIGGER appointments_log_delete
  AFTER DELETE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.log_appointment_delete();
