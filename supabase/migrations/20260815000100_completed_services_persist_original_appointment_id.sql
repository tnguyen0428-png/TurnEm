-- `CompletedEntry.originalAppointmentId` had always been memory-only: no
-- column existed and the client never mapped it. That silently disabled the
-- multi-block darkening sweep at ticket close (TicketModal) — after any page
-- refresh, or on any device that did not itself perform the service, every
-- completed row came back with originalAppointmentId undefined, so closing a
-- ticket could only darken the single block named by tickets.appointment_id.
-- On a multi-tech visit the other techs' blocks stayed light (Sonia,
-- 2026-08-14).
alter table public.completed_services
  add column if not exists original_appointment_id text;

comment on column public.completed_services.original_appointment_id is
  'Appointment id this completion was promoted from (walk-in synth block or real booking). Lets the ticket-close darkening sweep find EVERY block on a multi-tech visit, and survives refresh / works on other devices.';

-- Backfill where the link is unambiguous: a walk-in synth block whose id is
-- exactly `walkin:<completed id>`. Rows with no derivable link stay null.
update public.completed_services cs
set original_appointment_id = a.id
from public.appointments a
where cs.original_appointment_id is null
  and a.id = 'walkin:' || cs.id;
