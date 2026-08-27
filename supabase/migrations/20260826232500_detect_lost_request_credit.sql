-- A completed service recorded as NON-request whose own linked booking says it
-- IS a request for that same tech, for that same service.
--
-- Nancy x TOMMY, 2026-08-26: the slot read "request TOMMY" BEFORE check-in (the
-- receptionist photographed it), yet History recorded non-request at a FULL
-- turn instead of the half turn a request earns. Tony corrected it by hand.
-- Mechanism unknown - the queue entry is deleted at completion, so nothing
-- records what it held at check-in, and appointments.last_edited_at is useless
-- as evidence because the app rewrites it in bulk (46 rows in 8 minutes on
-- 2026-08-26).
--
-- Unlike the wrong-tech class, this one needs NOBODY'S MEMORY to action: the
-- booking is the authority and it is still on file. The appointment book has
-- been right every time this bug has fired.
--
-- Reads the LIVE board, so it must run BEFORE the 23:30 board reset. Archived
-- days cannot be checked this way - daily_history entries do not carry
-- originalAppointmentId.
--
-- Reports only. Turn values feed queue ORDER, so nothing here auto-corrects.
--
-- Verified 2026-08-26: 0 hits against ~30 request-backed services on a full
-- day, and Nancy's row matches every condition except is_requested (which she
-- flipped when hand-fixing it), so it would have caught her that morning.

create or replace function public.detect_lost_request_credit()
returns table (
  entry_id text,
  client_name text,
  staff_name text,
  services text[],
  turn_value numeric,
  appointment_id text,
  booked_as text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select cs.id,
         cs.client_name,
         cs.manicurist_name,
         cs.services,
         cs.turn_value,
         a.id,
         string_agg(distinct r->>'service', ', ')
  from public.completed_services cs
  join public.appointments a on a.id = cs.original_appointment_id
  cross join lateral jsonb_array_elements(a.service_requests) r
  where coalesce(cs.voided, false) = false
    and coalesce(cs.is_requested, false) = false
    and (r->>'clientRequest')::boolean is true
    and r->'manicuristIds' ? cs.manicurist_id
    and (r->>'service') = any(cs.services)
  group by cs.id, cs.client_name, cs.manicurist_name, cs.services, cs.turn_value, a.id;
$function$;
