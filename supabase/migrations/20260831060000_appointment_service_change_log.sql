-- Append-only forensics for what the appointment book SHOWS: every change to
-- an appointment's services[], service_requests[] or primary column, with the
-- before and after values and which device made it.
--
-- Why: on 2026-08-30 a service changed on an open ticket came back onto the
-- book as a second slot (Karen x SAM, Maddie x JOE), and reconstructing it
-- afterwards was guesswork -- appointments carry only last_edited_at, which
-- checkout bumps for a status-only write, so it cannot tell "a services write
-- happened" from "the block was greyed out". Three separate timestamp-based
-- reconstructions were confounded that way. Supabase's own request logs did
-- show the cause (four devices writing the same row within two seconds) but
-- they keep 24 hours and no request bodies. This table is the durable record.
--
-- Nothing reads it at runtime. It must never be able to block a write to
-- appointments, so the trigger swallows its own failures.
create table if not exists public.appointment_service_log (
  id                        bigserial primary key,
  logged_at                 timestamptz not null default now(),
  appointment_id            text        not null,
  op                        text        not null,
  appt_date                 text,
  client_name               text,
  -- what the book listed, before and after
  old_services              jsonb,
  new_services              jsonb,
  services_removed          text[],
  services_added            text[],
  -- the per-slot placements, before and after
  old_service_requests      jsonb,
  new_service_requests      jsonb,
  slots_before              int,
  slots_after               int,
  -- the block's primary column
  old_manicurist_id         text,
  new_manicurist_id         text,
  -- who and from where
  edited_by_receptionist_id text,
  device_ua                 text,
  device_ip                 text
);

comment on table public.appointment_service_log is
  'Append-only log of every change to an appointment''s services, service_requests or primary column. Written by trg_log_appointment_service_change. Nothing reads it at runtime; it exists so a wrong or duplicated slot on the book can be explained after the fact instead of reconstructed from timestamps.';

create index if not exists appointment_service_log_appt_idx
  on public.appointment_service_log (appointment_id, logged_at desc);
create index if not exists appointment_service_log_time_idx
  on public.appointment_service_log (logged_at desc);

alter table public.appointment_service_log enable row level security;
-- No policies on purpose: this is forensics, readable with the service role
-- only. The trigger is SECURITY DEFINER so it still writes under the anon key.

create or replace function public.log_appointment_service_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  o_services jsonb;
  o_requests jsonb;
  o_mani     text;
  remaining  jsonb;
  removed    text[] := '{}';
  added      text[] := '{}';
  el         text;
  idx        int;
  hdrs       json;
begin
  if tg_op = 'UPDATE' then
    o_services := old.services;
    o_requests := old.service_requests;
    o_mani     := old.manicurist_id;
    -- Only the three fields that decide what the book draws. Status-only
    -- writes (check-in, the checkout grey-out) are the common case and are
    -- deliberately not logged -- they are the noise that made last_edited_at
    -- useless as evidence.
    if o_services is not distinct from new.services
       and o_requests is not distinct from new.service_requests
       and o_mani     is not distinct from new.manicurist_id then
      return null;
    end if;
  end if;

  begin
    -- Count-aware diff so [Gel Fill, Gel Fill] -> [Gel Fill] reads as one
    -- removal, not none. A name-level diff would hide exactly the repeated
    -- service case that matters here.
    remaining := coalesce(new.services, '[]'::jsonb);
    for el in select value from jsonb_array_elements_text(coalesce(o_services, '[]'::jsonb)) loop
      idx := (select min(i) from generate_series(0, jsonb_array_length(remaining) - 1) i
               where remaining ->> i = el);
      if idx is null then
        removed := removed || el;
      else
        remaining := remaining - idx;
      end if;
    end loop;
    for el in select value from jsonb_array_elements_text(remaining) loop
      added := added || el;
    end loop;

    begin
      hdrs := current_setting('request.headers', true)::json;
    exception when others then
      hdrs := null;
    end;

    insert into public.appointment_service_log (
      appointment_id, op, appt_date, client_name,
      old_services, new_services, services_removed, services_added,
      old_service_requests, new_service_requests, slots_before, slots_after,
      old_manicurist_id, new_manicurist_id,
      edited_by_receptionist_id, device_ua, device_ip
    ) values (
      new.id, tg_op, new.date, new.client_name,
      o_services, new.services, removed, added,
      o_requests, new.service_requests,
      case when o_requests is null then null else jsonb_array_length(o_requests) end,
      case when new.service_requests is null then null else jsonb_array_length(new.service_requests) end,
      o_mani, new.manicurist_id,
      new.last_edited_by_receptionist_id,
      hdrs ->> 'user-agent',
      coalesce(hdrs ->> 'x-real-ip', hdrs ->> 'x-forwarded-for')
    );
  exception when others then
    -- Logging must never take the book down. Swallow and carry on.
    null;
  end;

  return null;
end;
$fn$;

drop trigger if exists trg_log_appointment_service_change on public.appointments;
create trigger trg_log_appointment_service_change
  after insert or update on public.appointments
  for each row execute function public.log_appointment_service_change();
