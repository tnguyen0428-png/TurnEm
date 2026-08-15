-- trg_sync_completed_service_prices only fires on the ticket's transition to
-- 'closed', and prices whatever completed_services rows exist AT THAT MOMENT.
-- The client flushes completed_services in debounced batches, so any row that
-- had not yet landed when the ticket closed never got a price -- permanently,
-- because the trigger never fires again for that ticket.
--
-- On 2026-08-14 that left 53 of 158 rows (~34%) unpriced across all 17
-- manicurists: $2,405 of work that appeared in the blueprint (money was
-- collected) but showed as $0 in the staff portal. `completed_at` is
-- client-supplied, so those rows looked "completed before close" while
-- actually being INSERTed after it -- which is why the timing was not
-- visible in the data.
--
-- Close the ordering hole from the other side: when a completed_services row
-- arrives with no price, look for an already-closed ticket line that owns it
-- and price it immediately. Together with the close-time trigger, both
-- orderings are covered regardless of which side wins the race.
create or replace function price_completed_service_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
begin
  if NEW.price_cents is not null then
    return NEW;
  end if;

  select sum(ti.ext_price_cents) into v_total
  from ticket_items ti
  join tickets t on t.id = ti.ticket_id
  where t.status = 'closed'
    and ti.queue_entry_id is not null
    and split_part(ti.queue_entry_id, '#', 1) = NEW.id;

  if v_total is not null then
    NEW.price_cents := v_total;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_price_completed_service_on_insert on public.completed_services;
create trigger trg_price_completed_service_on_insert
  before insert on public.completed_services
  for each row execute function price_completed_service_on_insert();
