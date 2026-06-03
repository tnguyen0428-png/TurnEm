-- Observability for the silent duplicate-appointment drops.
-- Every time reject_duplicate_appointment() rejects an INSERT (RETURN NULL),
-- record the rejected row + the existing row it matched, so we can see what
-- is actually being thrown away and decide whether the dedup key is too coarse.

CREATE TABLE IF NOT EXISTS public.appointment_drop_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dropped_at       timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL DEFAULT 'db_trigger',
  new_id           text,
  matched_id       text,
  date             text,
  "time"           text,
  manicurist_id    text,
  client_name      text,
  service          text,
  new_services     jsonb,
  matched_services jsonb,
  new_status       text,
  is_walk_in       boolean
);

CREATE OR REPLACE FUNCTION public.reject_duplicate_appointment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
BEGIN
  -- Same logic as before: drop a brand-new appointment that duplicates an
  -- existing non-cancelled one on (date, manicurist, time, client, service).
  -- BEFORE INSERT only -> editing/moving (UPDATE) is unaffected. Now we also
  -- log every drop so the disappearing-slot reports can be traced to data.
  IF NEW.status NOT IN ('cancelled', 'no-show') THEN
    SELECT a.id, a.services INTO v_match
    FROM public.appointments a
    WHERE a.id <> NEW.id
      AND a.status NOT IN ('cancelled', 'no-show')
      AND a.date = NEW.date
      AND COALESCE(a.manicurist_id, '') = COALESCE(NEW.manicurist_id, '')
      AND a."time" = NEW."time"
      AND a.client_name IS NOT DISTINCT FROM NEW.client_name
      AND a.service IS NOT DISTINCT FROM NEW.service
    LIMIT 1;

    IF FOUND THEN
      INSERT INTO public.appointment_drop_log(
        source, new_id, matched_id, date, "time", manicurist_id,
        client_name, service, new_services, matched_services, new_status, is_walk_in)
      VALUES (
        'db_trigger', NEW.id, v_match.id, NEW.date, NEW."time", NEW.manicurist_id,
        NEW.client_name, NEW.service, NEW.services, v_match.services, NEW.status, NEW.is_walk_in);

      RAISE NOTICE 'reject_duplicate_appointment: dropped dup date=% time=% mani=% client=% service=%',
        NEW.date, NEW."time", NEW.manicurist_id, NEW.client_name, NEW.service;
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
