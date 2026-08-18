-- Nightly reconciliation of the staff portal against the blueprint.
--
-- The portal and the blueprint answer the same question from two sides:
--   portal    = what each manicurist is credited (completed_services today,
--               daily_history for past days)
--   blueprint = what the client was actually charged (closed ticket_items,
--               credited by staff1_id)
-- They must agree to the penny. Every historical divergence has come from
-- price_cents being written wrong, written once, or not written at all.
--
-- The triggers added 2026-08-17 close the known causes. These functions are
-- the standing check that they stay closed, and the repair for anything that
-- still slips through.
--
-- The existing staff_earnings_reconciliation VIEW is deliberately left alone:
-- it only reads completed_services, so it is meaningful for the current day
-- only (the 2 AM board reset empties the table, making every past date report
-- as MISSING_FROM_PORTAL). These functions read the right source per day.


-- ── The receipt owed to ONE entry: that tech's own closed-ticket lines ─────
create or replace function public.entry_receipt_cents(
  p_entry_id       text,
  p_manicurist_id  text
) returns int
language sql
stable
security definer
set search_path = public
as $fn$
  select sum(ti.ext_price_cents)::int
  from public.ticket_items ti
  join public.tickets t on t.id = ti.ticket_id
  where t.status = 'closed'
    and ti.queue_entry_id is not null
    and split_part(ti.queue_entry_id, '#', 1) = p_entry_id
    and (ti.staff1_id is null or p_manicurist_id is null
         or ti.staff1_id = p_manicurist_id)
$fn$;

comment on function public.entry_receipt_cents(text, text) is
  'What one completed_services / daily_history entry is owed: the sum of its own tech closed-ticket lines. Null when the entry owns no line (an add-child, whose line carries the bare visit id, or work with no ticket).';


-- ── Day + tech rollup, modelling exactly what the portal displays ─────────
create or replace function public.reconcile_staff_earnings(p_from date, p_to date)
returns table (
  business_date     date,
  manicurist_id     text,
  manicurist_name   text,
  source            text,
  portal_cents      bigint,
  blueprint_cents   bigint,
  diff_cents        bigint,
  open_ticket_cents bigint
)
language sql
stable
security definer
set search_path = public
as $fn$
  with today as (
    select (now() at time zone 'America/Los_Angeles')::date as d
  ),
  -- Entries: the live board for today, the archive for every earlier day.
  ent as (
    select t.d as bd, cs.id, public.tickets_visit_id(cs.id) as visit,
           cs.manicurist_id as mani, cs.price_cents as pc,
           coalesce(cs.voided,false) as voided,
           (select coalesce(sum(round(ss.price*100)),0)
              from unnest(cs.services) s
              left join public.salon_services ss on ss.name = s) as cat,
           'live'::text as src
    from public.completed_services cs, today t
    where t.d between p_from and p_to
    union all
    select dh.date::date, x->>'id', public.tickets_visit_id(x->>'id'),
           x->>'manicuristId', (x->>'priceCents')::int,
           coalesce((x->>'voided')::boolean,false),
           (select coalesce(sum(round(ss.price*100)),0)
              from jsonb_array_elements_text(x->'services') s
              left join public.salon_services ss on ss.name = s),
           'archive'
    from public.daily_history dh, lateral jsonb_array_elements(dh.entries) x, today t
    where dh.date::date between p_from and p_to and dh.date::date <> t.d
  ),
  live_ent as (select * from ent where not voided),
  -- The portal's fallback map: every line a tech has on a visit.
  vmap as (
    select t.business_date as bd, t.queue_entry_id as visit,
           ti.staff1_id as mani, sum(ti.ext_price_cents) as cents
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.business_date between p_from and p_to
      and t.status in ('open','closed')
      and t.queue_entry_id is not null and ti.staff1_id is not null
    group by 1,2,3
  ),
  -- Mirrors allocateVisitFallbacks: an unpriced entry gets the share of the
  -- bucket its priced siblings have not claimed, never the whole bucket.
  bucket as (
    select e.bd, e.visit, e.mani, max(e.src) as src,
           sum(coalesce(e.pc,0)) as claimed,
           count(*) filter (where e.pc is null) as n_unpriced,
           sum(e.cat) filter (where e.pc is null) as cat_unpriced,
           max(v.cents) as visit_cents
    from live_ent e
    left join vmap v on v.bd = e.bd and v.visit = e.visit and v.mani = e.mani
    group by 1,2,3
  ),
  portal as (
    select bd, mani, max(src) as src,
           sum(claimed + case when n_unpriced = 0 then 0
                              when visit_cents is null then cat_unpriced
                              else greatest(0, visit_cents - claimed) end)::bigint as cents
    from bucket group by 1,2
  ),
  bp as (
    select t.business_date as bd, ti.staff1_id as mani,
           sum(ti.unit_price_cents*ti.quantity - coalesce(ti.discount_cents,0))::bigint as cents
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    join public.manicurists m on m.id = ti.staff1_id
    where t.business_date between p_from and p_to
      and t.status = 'closed' and ti.kind = 'service'
      and coalesce(m.is_receptionist,false) = false
    group by 1,2
  ),
  -- Work still on an OPEN ticket is not a discrepancy: the client has not
  -- paid yet, so the closed-only blueprint cannot see it.
  openv as (
    select t.business_date as bd, ti.staff1_id as mani,
           sum(ti.ext_price_cents)::bigint as cents
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.business_date between p_from and p_to
      and t.status = 'open' and ti.kind = 'service' and ti.staff1_id is not null
    group by 1,2
  )
  select coalesce(p.bd, b.bd),
         coalesce(p.mani, b.mani),
         m.name,
         coalesce(p.src, 'archive'),
         coalesce(p.cents, 0),
         coalesce(b.cents, 0),
         coalesce(p.cents,0) - coalesce(b.cents,0),
         coalesce(o.cents, 0)
  from portal p
  full join bp b on b.bd = p.bd and b.mani = p.mani
  left join openv o on o.bd = coalesce(p.bd,b.bd) and o.mani = coalesce(p.mani,b.mani)
  left join public.manicurists m on m.id = coalesce(p.mani, b.mani)
  where coalesce(p.cents,0) <> coalesce(b.cents,0)
  order by 1 desc, 7 desc;
$fn$;

comment on function public.reconcile_staff_earnings(date, date) is
  'Per day and manicurist, portal total vs blueprint total, for every pair that disagrees. open_ticket_cents is work not yet paid for and explains a negative diff on the current day.';


-- ── Repair: fix what the receipt determines, leave the rest to a human ────
create or replace function public.repair_staff_earnings(p_from date, p_to date)
returns table (
  business_date   date,
  entry_id        text,
  manicurist_name text,
  client_name     text,
  source          text,
  old_cents       int,
  new_cents       int
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_day   date;
begin
  create temp table if not exists _repairs (
    business_date date, entry_id text, manicurist_name text,
    client_name text, source text, old_cents int, new_cents int
  ) on commit drop;
  delete from _repairs;

  -- Today: the live board. Snapshot the before-state, let the shared
  -- recompute run over every closed ticket, then diff. Reusing
  -- reprice_completed_services_for_ticket keeps this identical to what the
  -- triggers do, so the nightly pass can never disagree with them.
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

  -- Earlier days: the archive. Only entries whose own receipt is
  -- determinable are touched. An add-child owns no line of its own, so it is
  -- left alone: the portal's remainder fallback already prices it correctly
  -- and writing a guess here would bake in a number nobody verified.
  for v_day in
    select d::date from generate_series(p_from, p_to, interval '1 day') d
    where d::date <> v_today
  loop
    insert into _repairs
    select v_day, x->>'id', x->>'manicuristName', x->>'clientName', 'archive',
           (x->>'priceCents')::int,
           public.entry_receipt_cents(x->>'id', x->>'manicuristId')
    from daily_history dh, lateral jsonb_array_elements(dh.entries) x
    where dh.date::date = v_day
      and coalesce((x->>'voided')::boolean,false) = false
      and public.entry_receipt_cents(x->>'id', x->>'manicuristId') is not null
      and public.entry_receipt_cents(x->>'id', x->>'manicuristId')
          is distinct from (x->>'priceCents')::int;

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
$fn$;

comment on function public.repair_staff_earnings(date, date) is
  'Correct every entry whose stored price disagrees with its own tech receipt, and return what changed. Entries that own no ticket line are left untouched for a human to judge.';


-- ── Repair only where the id mapping is provably complete ────────────────
--
-- The first cut of repair_staff_earnings above rewrote any entry whose stored
-- price differed from entry_receipt_cents. A dry run showed that would revert
-- LY's Lani entry from the correct $105 back to $55: her entry was
-- consolidated by hand to cover Gel Pedicure + Gel Manicure, but the Gel
-- Manicure LINE still hangs off her voided '-mani-8' sibling, so a per-entry
-- id match only ever finds $55. Rewriting it would have made the portal
-- disagree with the blueprint again -- the exact bug this job exists to catch.
--
-- So repair only where the live entries' own receipts sum to the bucket's full
-- ticket total. That is the condition under which the mapping is provably
-- complete and no line is hiding behind a voided or add-child row. Everything
-- else is reported for a human, unrepaired.

create or replace function public.repair_staff_earnings(p_from date, p_to date)
returns table (
  business_date   date,
  entry_id        text,
  manicurist_name text,
  client_name     text,
  source          text,
  old_cents       int,
  new_cents       int
)
language plpgsql
security definer
set search_path = public
as $fn$
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
             public.tickets_visit_id(x->>'id') as visit,
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
      select t.queue_entry_id as visit, ti.staff1_id as mani,
             sum(ti.ext_price_cents) as cents
      from ticket_items ti join tickets t on t.id = ti.ticket_id
      where t.business_date = v_day and t.status in ('open','closed')
        and t.queue_entry_id is not null and ti.staff1_id is not null
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
$fn$;
