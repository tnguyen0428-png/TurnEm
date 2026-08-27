-- repair_staff_earnings matched ticket money by the TICKET HEADER's
-- queue_entry_id while board entries key off the entry id. When a ticket's
-- header points at one visit and its LINES at another, the two never join, the
-- entry fails the `complete` gate, and it is skipped SILENTLY - reported as
-- "repaired 0", which reads identically to "nothing was wrong".
--
--   MACY 08/25: ticket #57 header c720c09e..., line df47218e... -> $65 needed a
--     hand repair.
--   KIM 08/21: pedicure re-homed onto ticket #64 (header c53315a1...) while her
--     own ticket #78 was voided; the line still carries 14e26e03...#1. $40 of
--     collected work, credited $0.
--
-- Fix: key vtot on the LINE's visit id, not the header's. Also coalesce a
-- non-UUID id back to the raw id on both sides - tickets_visit_id returns NULL
-- there, and a NULL never joins, so such rows vanish from the comparison with
-- no error (26 ticket_items + 14 tickets today, all from the 2026-06-09
-- turnfix- manual repair batch). This also aligns the DB with the client's
-- getVisitId, which returns the id unchanged rather than null on no match.
--
-- Measured over 2026-08-01..25 BEFORE applying: 1 row newly repairable (KIM's
-- $40), 0 rows lost. The today/live branch is untouched.
--
-- This matters more now that cron job 17 (postarchive-reconcile, 00:20 LA)
-- runs repair automatically every night: without this, that job would keep
-- reporting "repaired 0" on this whole class while looking healthy.

CREATE OR REPLACE FUNCTION public.repair_staff_earnings(p_from date, p_to date)
 RETURNS TABLE(business_date date, entry_id text, manicurist_name text, client_name text, source text, old_cents integer, new_cents integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_day   date;
begin
  create temp table if not exists _repairs (
    business_date date, entry_id text, manicurist_name text,
    client_name text, source text, old_cents int, new_cents int
  ) on commit drop;
  delete from _repairs;

  -- Today: delegate to the same recompute the triggers use, so the nightly
  -- pass can never disagree with them.
  if v_today between p_from and p_to then
    create temp table if not exists _before (id text primary key, price_cents int)
      on commit drop;
    delete from _before;
    insert into _before select cs.id, cs.price_cents from completed_services cs;

    perform public.reprice_completed_services_for_ticket(t.id)
    from tickets t
    where t.business_date = v_today and t.status = 'closed';

    insert into _repairs
    select v_today, cs.id, cs.manicurist_name, cs.client_name, 'live',
           b.price_cents, cs.price_cents
    from completed_services cs
    join _before b on b.id = cs.id
    where cs.price_cents is distinct from b.price_cents;
  end if;

  for v_day in
    select d::date from generate_series(p_from, p_to, interval '1 day') d
    where d::date <> v_today
  loop
    insert into _repairs
    with live_ent as (
      select x->>'id' as id,
             coalesce(public.tickets_visit_id(x->>'id'), x->>'id') as visit,
             x->>'manicuristId' as mani,
             x->>'manicuristName' as mname,
             x->>'clientName' as cname,
             (x->>'priceCents')::int as pc,
             public.entry_receipt_cents(x->>'id', x->>'manicuristId') as own_cents
      from daily_history dh, lateral jsonb_array_elements(dh.entries) x
      where dh.date::date = v_day
        and coalesce((x->>'voided')::boolean,false) = false
    ),
    bucket as (
      select visit, mani, sum(coalesce(own_cents,0)) as own_sum
      from live_ent group by 1,2
    ),
    vtot as (
      -- Key on the LINE's visit id. The header's queue_entry_id is a different
      -- thing and drifts from its lines whenever work is re-homed or a visit
      -- is re-keyed by a split.
      select coalesce(public.tickets_visit_id(ti.queue_entry_id), ti.queue_entry_id) as visit,
             ti.staff1_id as mani,
             sum(ti.ext_price_cents) as cents
      from ticket_items ti join tickets t on t.id = ti.ticket_id
      where t.business_date = v_day and t.status in ('open','closed')
        and ti.queue_entry_id is not null and ti.staff1_id is not null
      group by 1,2
    ),
    complete as (
      select b.visit, b.mani
      from bucket b join vtot v on v.visit = b.visit and v.mani = b.mani
      where b.own_sum = v.cents
    )
    select v_day, e.id, e.mname, e.cname, 'archive', e.pc, e.own_cents
    from live_ent e
    join complete c on c.visit = e.visit and c.mani = e.mani
    where e.own_cents is not null
      and e.own_cents is distinct from e.pc;

    update daily_history dh
    set entries = (
      select jsonb_agg(
               case when r.entry_id is null then e.x
                    else jsonb_set(e.x, '{priceCents}', to_jsonb(r.new_cents))
               end order by e.ord)
      from jsonb_array_elements(dh.entries) with ordinality as e(x, ord)
      left join _repairs r
        on r.business_date = v_day and r.source = 'archive' and r.entry_id = e.x->>'id'
    )
    where dh.date::date = v_day
      and exists (select 1 from _repairs r
                  where r.business_date = v_day and r.source = 'archive');
  end loop;

  return query select * from _repairs order by 1 desc, 3, 2;
end;
$function$;
