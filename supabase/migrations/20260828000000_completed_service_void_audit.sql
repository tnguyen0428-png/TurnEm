-- ─────────────────────────────────────────────────────────────────────────────
-- Make "who voided this history row, and when" answerable.
--
-- WHY (Molani 2, 2026-08-27): a completed_services row for a $55 Gel Pedicure
-- came back marked voided=true. Ticket voids record `voided_by_receptionist_id`
-- and `void_reason`; completed-entry voids recorded NOTHING — no actor, no
-- timestamp, no reason, and TOGGLE_VOID_COMPLETED does not even set `edited`.
-- The tech lost the service from History and the salon kept the money, and the
-- cause could not be traced. It still cannot.
--
-- TWO PARTS, and the LOG is the one that would actually have solved it.
--
-- Part 1 - the log. Molani 2's flag did NOT arrive through the void button.
-- There was no targeted write to that row at all; it came in through the app's
-- bulk `POST /completed_services?on_conflict=id` state sync. A stamp populated
-- only by the void button would have been EMPTY and the investigation would
-- have hit the same wall. A trigger catches every writer whatever the route -
-- button, bulk sync, cron, psql - and records the exact moment of the flip,
-- which is all that was missing.
--
-- Part 2 - the stamp. The app ALREADY identifies the person: EditCompletedModal
-- puts a PIN gate in front of the void, and ReceptionistPinGate hands back
-- `(receptionistId, reason)`. EditCompletedModal's handler took no arguments and
-- dropped both on the floor. These columns give them somewhere to live.
--
-- Forensics only. Nothing here changes what voiding does.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Part 2: the stamp ───────────────────────────────────────────────────────
-- Mirrors the trio already on `tickets`. Nullable throughout: every existing
-- row predates this, and a void that arrives from a non-button path (the bulk
-- sync) legitimately has no actor to record — the log below still captures it.
alter table public.completed_services
  add column if not exists voided_by_receptionist_id text,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;

comment on column public.completed_services.voided_by_receptionist_id is
  'Receptionist who voided this row via the History edit modal''s PIN gate. NULL means the void did not come through that button - check completed_services_void_log for what did.';

-- ── Part 1: the log ─────────────────────────────────────────────────────────
create table if not exists public.completed_services_void_log (
  log_id                    bigserial primary key,
  changed_at                timestamptz not null default now(),
  op                        text        not null,
  id                        text        not null,
  client_name               text,
  manicurist_id             text,
  manicurist_name           text,
  turn_value                numeric,
  was_voided                boolean,
  now_voided                boolean,
  voided_by_receptionist_id text,
  void_reason               text,
  row_data                  jsonb
);

comment on table public.completed_services_void_log is
  'Every transition of completed_services.voided, from ANY writer - the History void button, the bulk state sync, cron, or a hand-run statement. Append-only forensics; nothing reads it at runtime. was_voided/now_voided make un-voids as visible as voids, since the button is a toggle.';

create index if not exists completed_services_void_log_id_idx
  on public.completed_services_void_log (id, changed_at desc);
create index if not exists completed_services_void_log_changed_at_idx
  on public.completed_services_void_log (changed_at desc);

-- RLS on, no policies - same shape as completed_services_delete_log. The
-- trigger writes as SECURITY DEFINER so it is unaffected; the client can
-- neither read nor write it, which is what we want for an audit trail. Read it
-- with the service role. (See the RLS auto-enable trap: a new table gets RLS
-- switched on automatically here, so this is explicit rather than accidental.)
alter table public.completed_services_void_log enable row level security;

create or replace function public.log_completed_service_void()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Never block a void because logging failed. Same contract as
  -- log_completed_service_delete.
  begin
    insert into public.completed_services_void_log
      (op, id, client_name, manicurist_id, manicurist_name, turn_value,
       was_voided, now_voided, voided_by_receptionist_id, void_reason, row_data)
    values
      (tg_op, new.id, new.client_name, new.manicurist_id, new.manicurist_name,
       new.turn_value,
       case when tg_op = 'UPDATE' then old.voided else null end,
       new.voided, new.voided_by_receptionist_id, new.void_reason, to_jsonb(new));
  exception when others then
    null;
  end;
  return null;
end;
$function$;

-- Two triggers, one function, so each can carry a precise WHEN clause (TG_OP is
-- not available inside a trigger WHEN).
--
-- The UPDATE one is the important one: an upsert from the app's bulk sync lands
-- as INSERT ... ON CONFLICT DO UPDATE, which fires this. That is the exact path
-- that flipped Molani 2 and left no trace.
drop trigger if exists log_completed_service_void_update on public.completed_services;
create trigger log_completed_service_void_update
  after update of voided on public.completed_services
  for each row
  when (old.voided is distinct from new.voided)
  execute function public.log_completed_service_void();

-- A row can also be created already-voided.
drop trigger if exists log_completed_service_void_insert on public.completed_services;
create trigger log_completed_service_void_insert
  after insert on public.completed_services
  for each row
  when (new.voided is true)
  execute function public.log_completed_service_void();
