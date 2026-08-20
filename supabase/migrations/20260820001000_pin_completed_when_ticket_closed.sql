-- A block whose visit has been paid for cannot go back to checked-in.
--
-- Carol Demham, 08/19: ticket #35 closed and paid $80.00 at 12:39 PT and the
-- close-trigger marked her block `completed` -- it darkened. At 1:11 PM someone
-- saved that block from a device still holding the pre-checkout copy, and the
-- save carried `checked-in` with it. The block went pale again.
--
-- reject_stale_appointment_status_downgrade already existed to stop exactly
-- this, but it decides by asking whether the incoming `last_edited_at` is newer
-- than the stored one. Every client stamps now() on the way out, so a stale copy
-- always looks newer and the test cannot see it. It only ever caught writes that
-- forgot to bump the clock.
--
-- Ask a question staleness cannot fake instead: does this visit have a CLOSED
-- ticket? If money has been taken the visit is over, and no device's opinion
-- changes that. The escape hatch is voiding the ticket -- a voided ticket is
-- status 'voided', not 'closed', so the guard lets the block move again.
--
-- The timestamp rule is kept as a fallback for blocks with no ticket at all.
create or replace function public.reject_stale_appointment_status_downgrade()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_visit             text;
  v_has_closed_ticket boolean := false;
begin
  if OLD.status = 'completed'
     and NEW.status in ('checked-in', 'scheduled')
  then
    -- Walk-in blocks are keyed `walkin:<queue entry id>`; resolve that to the
    -- visit so a ticket opened on any sibling entry of the same visit counts.
    if NEW.id like 'walkin:%' then
      v_visit := public.tickets_visit_id(substring(NEW.id from 8));
    end if;

    select exists (
      select 1
        from public.tickets t
       where t.status = 'closed'
         and (
           t.appointment_id = NEW.id
           or (v_visit is not null
               and t.queue_entry_id is not null
               and public.tickets_visit_id(t.queue_entry_id) = v_visit)
         )
    ) into v_has_closed_ticket;

    if v_has_closed_ticket
       or NEW.last_edited_at is null
       or OLD.last_edited_at is null
       or NEW.last_edited_at <= OLD.last_edited_at
    then
      -- Keep the completion. Everything else in the incoming row is allowed
      -- through: this guards the one field a stale copy demonstrably corrupts,
      -- not the whole row.
      NEW.status := OLD.status;
      NEW.last_edited_at := OLD.last_edited_at;
    end if;
  end if;

  return NEW;
end;
$fn$;
