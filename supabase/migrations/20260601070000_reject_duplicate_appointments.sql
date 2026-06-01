-- Prevent phantom duplicate appointments at the database level.
--
-- The queue re-synch effect (src/state/AppContext.tsx) and synthWalkInAppt can
-- dispatch ADD_APPOINTMENT more than once for the same logical booking, which
-- created duplicate appointment rows. Those phantoms showed a false "!"
-- double-booking flag and falsely blocked drag-to-move ("slot taken" on an
-- empty-looking book).
--
-- Companion to the client-side guard added in the ADD_APPOINTMENT reducer case
-- (src/state/reducer.ts). This trigger is the server-side safety net so even a
-- device still on an older build can't persist a duplicate.
--
-- BEFORE INSERT only: silently drops (RETURN NULL) a new appointment that
-- duplicates an existing NON-cancelled one on the same
-- (date, manicurist, time, client, service). Two DIFFERENT clients at the same
-- time differ by client_name, so a real double-booking is preserved. Editing
-- or moving an existing appointment is an UPDATE and is unaffected.
--
-- Applied live to the TurnEM Salon project on 2026-06-01.

CREATE OR REPLACE FUNCTION public.reject_duplicate_appointment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status NOT IN ('cancelled', 'no-show') AND EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.id <> NEW.id
      AND a.status NOT IN ('cancelled', 'no-show')
      AND a.date = NEW.date
      AND COALESCE(a.manicurist_id, '') = COALESCE(NEW.manicurist_id, '')
      AND a."time" = NEW."time"
      AND a.client_name IS NOT DISTINCT FROM NEW.client_name
      AND a.service IS NOT DISTINCT FROM NEW.service
  ) THEN
    RAISE NOTICE 'reject_duplicate_appointment: dropped dup date=% time=% mani=% client=% service=%',
      NEW.date, NEW."time", NEW.manicurist_id, NEW.client_name, NEW.service;
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_reject_duplicate ON public.appointments;
CREATE TRIGGER appointments_reject_duplicate
BEFORE INSERT ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.reject_duplicate_appointment();
