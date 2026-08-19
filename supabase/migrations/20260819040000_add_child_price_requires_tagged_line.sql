-- add_child_price_cents priced an add-child off MAY receipts.
--
-- LEO / Penny, 08/18: the add-child was priced $264.00 -- the sum of five
-- untagged "Gel Pedicure" lines of his from 2026-05-14. Penny's ticket had
-- collected $40.00, all of it TOMMY's.
--
-- The visit guard read:
--
--   coalesce(split_part(ti.queue_entry_id, '#', 1), r.visit) = r.visit
--
-- For a line whose queue_entry_id is NULL, split_part returns NULL and the
-- coalesce substitutes the very visit being searched for -- so the row compares
-- the visit to itself and can never fail. The visit scope evaporates for
-- exactly those lines, and nothing else bounds the search by date or ticket, so
-- it summed every untagged closed line for that staff + service name, forever.
-- ~200 such lines exist from 2026-05-12..22 (they were typed onto tickets
-- rather than flowing from the board), spread over most of the staff.
--
-- Require the tag to exist before trusting it. An untagged line can then never
-- match a visit, the fallback returns null, and an add-child the register never
-- billed reads $0 instead of inventing a number. reprice_completed_services_for
-- _ticket already guards its own passes this way; this was the odd one out.
--
-- Dry run over every archived add-child since 08/01: only LEO/Penny changes
-- (26400 -> null). Every other add-child's stored price already came from the
-- exact-id pass, which was never affected.
create or replace function public.add_child_price_cents(p_cs_id text, p_manicurist_id text, p_services text[])
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  with r as (select public.tickets_visit_id(p_cs_id) as visit)
  select sum(ti.ext_price_cents)::int
  from public.ticket_items ti
  join public.tickets t on t.id = ti.ticket_id
  cross join r
  where p_cs_id like '%-add-%'
    and r.visit is not null
    and p_manicurist_id is not null
    and t.status = 'closed'
    and ti.kind = 'service'
    and ti.staff1_id = p_manicurist_id
    and ti.name = any(coalesce(p_services, '{}'::text[]))
    and ti.queue_entry_id is not null
    and split_part(ti.queue_entry_id, '#', 1) = r.visit
    and not exists (
      select 1 from public.completed_services cs2
      where cs2.id = split_part(ti.queue_entry_id, '#', 1)
        and cs2.manicurist_id is not distinct from ti.staff1_id
    )
    and not exists (
      select 1 from public.completed_services cs3
      where cs3.id like r.visit || '%-add-%'
        and cs3.id <> p_cs_id
        and cs3.manicurist_id = p_manicurist_id
        and ti.name = any(cs3.services)
    )
$function$;

comment on function public.add_child_price_cents(text, text, text[]) is
  'Price for an "+ Add line" child entry: the closed service lines on ITS OWN visit, by that staff, matching one of its service names. Untagged (null queue_entry_id) lines never match -- see 20260819040000.';
