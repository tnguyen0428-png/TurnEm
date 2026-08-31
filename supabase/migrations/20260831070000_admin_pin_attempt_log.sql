-- Every attempt at a master-PIN gate, granted or denied, with which gate and
-- from what device. Append-only; the owner also gets a push per attempt (see
-- PinVerifyModal). Denied attempts matter as much as granted ones -- a run of
-- them is somebody trying codes.
create table if not exists public.admin_pin_attempt_log (
  id            bigserial primary key,
  attempted_at  timestamptz not null default now(),
  gate          text        not null,   -- which surface: 'history:previous-day', 'register:closed-shift', ...
  detail        text,                   -- what specifically: the date, the shift id
  outcome       text        not null,   -- 'granted' | 'denied'
  device_ua     text,
  device_ip     text
);

comment on table public.admin_pin_attempt_log is
  'Append-only record of master-PIN attempts: which gate, granted or denied, when, and from which device. Nothing reads it at runtime.';

create index if not exists admin_pin_attempt_log_time_idx
  on public.admin_pin_attempt_log (attempted_at desc);

alter table public.admin_pin_attempt_log enable row level security;

-- The app writes these under the anon key, so it needs INSERT. There is
-- deliberately NO select policy: staff can add to the record and never read
-- it. Reading is service-role only, same posture as the other audit tables.
drop policy if exists admin_pin_attempt_log_insert on public.admin_pin_attempt_log;
create policy admin_pin_attempt_log_insert
  on public.admin_pin_attempt_log
  for insert to anon, authenticated
  with check (true);

-- Device attribution is filled server-side from the PostgREST request headers
-- rather than trusted from the client -- the whole point is a record of who
-- reached for the gate, so the client does not get to author that part.
create or replace function public.stamp_admin_pin_attempt_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  hdrs json;
begin
  begin
    hdrs := current_setting('request.headers', true)::json;
    new.device_ua := hdrs ->> 'user-agent';
    new.device_ip := coalesce(hdrs ->> 'x-real-ip', hdrs ->> 'x-forwarded-for');
  exception when others then
    null; -- never block the write over provenance
  end;
  return new;
end;
$fn$;

drop trigger if exists trg_stamp_admin_pin_attempt_device on public.admin_pin_attempt_log;
create trigger trg_stamp_admin_pin_attempt_device
  before insert on public.admin_pin_attempt_log
  for each row execute function public.stamp_admin_pin_attempt_device();
