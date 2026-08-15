-- Stop a stale client flush from un-completing a paid appointment.
--
-- tickets_complete_appointment_on_close flips the appointment to 'completed'
-- when its ticket closes. But the client mirrors appointments with a full-row
-- upsert and writes last_edited_at from ITS OWN local value (apptToRow), not
-- now(). So a device still holding the pre-checkout copy can land after the
-- trigger and revert status to 'checked-in', carrying an OLDER timestamp with
-- it. The block then stays light on the book even though the ticket is closed
-- and paid.
--
-- Observed 2026-08-14 on Alice Talbot (#25) and Sonia (#50): both rows showed
-- status 'checked-in' with last_edited_at ~450ms BEFORE their ticket closed --
-- a trigger write would have carried now(), so the client's stale copy had
-- landed on top.
--
-- Guard, deliberately narrow: only refuse a completed -> checked-in/scheduled
-- move, and only when the incoming write is NOT newer than what is stored.
-- A deliberate change always carries a fresh timestamp (the reducer stamps
-- lastEditedAt: Date.now() on every UPDATE_APPOINTMENT), so real edits and
-- reverts still pass. Only a write from a device that never learned about the
-- completion is rejected.
create or replace function reject_stale_appointment_status_downgrade()
returns trigger
language plpgsql
as $$
begin
  if OLD.status = 'completed'
     and NEW.status in ('checked-in', 'scheduled')
     and (
       NEW.last_edited_at is null
       or OLD.last_edited_at is null
       or NEW.last_edited_at <= OLD.last_edited_at
     )
  then
    NEW.status := OLD.status;
    NEW.last_edited_at := OLD.last_edited_at;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_reject_stale_appointment_status_downgrade on public.appointments;
create trigger trg_reject_stale_appointment_status_downgrade
  before update on public.appointments
  for each row execute function reject_stale_appointment_status_downgrade();
