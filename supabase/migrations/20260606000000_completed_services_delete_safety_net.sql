-- Non-blocking delete-capture safety net for completed_services.
-- Until every POS device runs the guarded client (see AppContext.tsx syncCompleted
-- explicit-delete ledger), an old-code device can still fire the race-induced
-- diff-delete that silently dropped real turn history (the 6/5 missing-morning-turns
-- incident). This AFTER DELETE trigger copies every deleted row (full jsonb + key
-- columns) into a log so NOTHING is ever permanently lost — wrong deletes are
-- recoverable from this table.
--
-- Hard lessons applied (cf. appointment_delete_log): the function is SECURITY
-- DEFINER (so its INSERT bypasses the log table's RLS) and its body swallows all
-- exceptions, so logging can NEVER roll back / block a legitimate delete or take
-- down the register.
--
-- NOTE: applied live via MCP on 2026-06-06; this file backfills the repo so the
-- migration history matches the database.

CREATE TABLE IF NOT EXISTS public.completed_services_delete_log (
  log_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  id               text,
  client_name      text,
  service          text,
  services         jsonb,
  turn_value       numeric,
  manicurist_id    text,
  manicurist_name  text,
  manicurist_color text,
  started_at       timestamptz,
  completed_at     timestamptz,
  voided           boolean,
  edited           boolean,
  row_data         jsonb
);

ALTER TABLE public.completed_services_delete_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.log_completed_service_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    INSERT INTO public.completed_services_delete_log
      (id, client_name, service, services, turn_value, manicurist_id,
       manicurist_name, manicurist_color, started_at, completed_at,
       voided, edited, row_data)
    VALUES
      (OLD.id, OLD.client_name, OLD.service, to_jsonb(OLD.services), OLD.turn_value,
       OLD.manicurist_id, OLD.manicurist_name, OLD.manicurist_color,
       OLD.started_at, OLD.completed_at, OLD.voided, OLD.edited, to_jsonb(OLD));
  EXCEPTION WHEN OTHERS THEN
    -- Never block a delete because logging failed.
    NULL;
  END;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS completed_services_log_delete ON public.completed_services;
CREATE TRIGGER completed_services_log_delete
AFTER DELETE ON public.completed_services
FOR EACH ROW EXECUTE FUNCTION public.log_completed_service_delete();
