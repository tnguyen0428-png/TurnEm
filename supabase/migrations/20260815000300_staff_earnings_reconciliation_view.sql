-- Standing reconciliation between what the CUSTOMER paid (ticket_items on
-- closed tickets -- the receipt) and what the STAFF PORTAL shows
-- (completed_services). These are two independent records of the same event,
-- written by different code paths at different times and joined only by a
-- string id, so they can and do drift silently:
--   2026-08-14: 53 rows unpriced ($2,405 invisible in the portal)
--   2026-08-14: September's two Nail Arts had no history row at all
--   2026-08-14: Christina's Eyebrows history id (-add-mani-15) did not match
--               the billed line id (-mani-17)
--
-- Nobody noticed any of it, because a missing row just looks like "that
-- service didn't happen". This view makes the drift visible.
--
-- issue values:
--   OK                  matched, same staff, same money
--   MISSING_FROM_PORTAL billed on a closed ticket, no history row -> staff not credited
--   NOT_BILLED          in the portal, no closed-ticket line -> money not collected
--   PRICE_MISMATCH      both exist, amounts differ
--   STAFF_MISMATCH      both exist, credited to a different tech than the receipt
create or replace view public.staff_earnings_reconciliation as
with lines as (
  select t.business_date,
         split_part(ti.queue_entry_id, '#', 1) as cs_id,
         min(t.ticket_number)                  as ticket_number,
         min(ti.staff1_id)                     as line_staff_id,
         string_agg(distinct ti.staff1_name, ', ') as line_staff,
         string_agg(ti.name, ' + ')            as line_services,
         sum(ti.ext_price_cents)               as line_cents
  from public.ticket_items ti
  join public.tickets t on t.id = ti.ticket_id
  where t.status = 'closed'
    and ti.kind = 'service'
    and ti.queue_entry_id is not null
  group by 1, 2
),
hist as (
  select cs.id as cs_id,
         cs.client_name,
         cs.manicurist_id,
         cs.manicurist_name,
         array_to_string(cs.services, ' + ') as hist_services,
         cs.price_cents,
         cs.turn_value,
         cs.completed_at
  from public.completed_services cs
  where not cs.voided
)
select
  coalesce(l.business_date,
           (h.completed_at at time zone 'America/Los_Angeles')::date) as business_date,
  coalesce(l.cs_id, h.cs_id)                as entry_id,
  h.client_name,
  l.ticket_number,
  coalesce(h.manicurist_name, l.line_staff) as staff,
  coalesce(h.hist_services, l.line_services) as services,
  l.line_cents                              as billed_cents,
  h.price_cents                             as portal_cents,
  coalesce(l.line_cents, 0) - coalesce(h.price_cents, 0) as diff_cents,
  h.turn_value,
  case
    when h.cs_id is null                              then 'MISSING_FROM_PORTAL'
    when l.cs_id is null                              then 'NOT_BILLED'
    when h.manicurist_id is distinct from l.line_staff_id then 'STAFF_MISMATCH'
    when coalesce(h.price_cents, -1) <> l.line_cents  then 'PRICE_MISMATCH'
    else 'OK'
  end as issue
from lines l
full outer join hist h on h.cs_id = l.cs_id;

comment on view public.staff_earnings_reconciliation is
  'Per-service comparison of the receipt (closed ticket_items) against the staff portal (completed_services). Filter on business_date and issue <> ''OK''.';

grant select on public.staff_earnings_reconciliation to anon, authenticated, service_role;
