-- The paid ticket decides who did the service.
--
-- Monique Aoki × Gel Polish Feet (2026-11-18, ticket #54): the ticket line was
-- TAMMY's, but the History entry had been moved to HANA (History "Edit
-- Service" changes the entry and never the ticket). Pricing at close only
-- prices an entry whose tech matches its line, so the entry was left with no
-- price, the portal fell back to the $38 catalog price, and HANA was paid for
-- TAMMY's work. The nightly check saw it but was built never to move a credit
-- between techs, so it sat until the tech noticed her pay was short.
--
-- Rule from here on: when an entry has a line on a CLOSED ticket, the entry's
-- tech (and price) follows that line.
--
-- Deliberately narrow, so it can't weld or steal work:
--   * Only an EXACT id match (ticket_items.queue_entry_id = entry id). A
--     cashier "+ Add line" is stored as `${visit}#n`, which shares its prefix
--     with the FIRST tech's row; matching on the prefix would move that tech's
--     row to the added tech (Jasmine Muro × MACY/JOE, 2026-11-20).
--   * Only when every closed line for that entry names the SAME tech.
--   * Voided entries are left alone.
-- Over the 30 days of History on hand (2,131 live entries) this rule matched
-- exactly one entry: Monique's.
--
-- Every move is logged in ticket_tech_moves and printed in the nightly report.

-- ── 1. Audit log ───────────────────────────────────────────────────────────
create table if not exists public.ticket_tech_moves (
  id             bigint generated always as identity primary key,
  moved_at       timestamptz not null default now(),
  source         text        not null check (source in ('live','archive')),
  business_date  date,
  ticket_number  int,
  entry_id       text        not null,
  client_name    text,
  services       text,
  from_tech_id   text,
  from_tech      text,
  to_tech_id     text        not null,
  to_tech        text,
  old_cents      int,
  new_cents      int
);
alter table public.ticket_tech_moves enable row level security;
comment on table public.ticket_tech_moves is
  'History entries moved to the tech on their paid ticket line. See migration 20261123120000.';

-- ── 2. Who the paid ticket says did this entry ─────────────────────────────
create or replace function public.paid_ticket_staff_for_entry(p_entry_id text)
returns table (
  staff1_id     text,
  staff1_name   text,
  staff1_color  text,
  cents         int,
  ticket_id     uuid,
  ticket_number int,
  business_date date
)
language sql
stable
security definer
set search_path = public
as $fn$
  with lines as (
    select ti.staff1_id, ti.staff1_name, ti.staff1_color, ti.ext_price_cents,
           t.id as ticket_id, t.ticket_number, t.business_date, t.closed_at
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.status = 'closed'
      and ti.kind = 'service'
      and ti.queue_entry_id = p_entry_id
  )
  select (array_agg(l.staff1_id))[1],
         (array_agg(l.staff1_name order by l.closed_at desc))[1],
         (array_agg(l.staff1_color order by l.closed_at desc))[1],
         sum(l.ext_price_cents)::int,
         (array_agg(l.ticket_id order by l.closed_at desc))[1],
         (array_agg(l.ticket_number order by l.closed_at desc))[1],
         (array_agg(l.business_date order by l.closed_at desc))[1]
  from lines l
  having count(*) > 0
     and count(l.staff1_id) = count(*)          -- every line has a tech
     and count(distinct l.staff1_id) = 1;       -- and they all agree
$fn$;

-- ── 3. Live board: align before pricing ────────────────────────────────────
-- Called on ticket close, on any line edit of a closed ticket, and when an
-- entry's tech changes (so a History edit that disagrees with a paid ticket
-- snaps straight back). The update fires recompute_turns_from_completed, so
-- the turn moves with the credit, and re-enters this function through
-- trg_reprice_on_completed_staff_change; on re-entry nothing disagrees, so it
-- just prices.
create or replace function public.reprice_completed_services_for_ticket(p_ticket_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_visit text;
begin
  select public.tickets_visit_id(queue_entry_id) into v_visit
  from public.tickets where id = p_ticket_id;
  if v_visit is null then
    return;
  end if;

  -- 0. The paid ticket decides the tech.
  with want as (
    select cs.id, cs.manicurist_id as old_id, cs.manicurist_name as old_name,
           cs.client_name, array_to_string(cs.services, ' + ') as services,
           cs.price_cents as old_cents,
           p.staff1_id, coalesce(m.name, p.staff1_name) as new_name,
           coalesce(m.color, p.staff1_color, cs.manicurist_color) as new_color,
           p.cents, p.ticket_number, p.business_date
    from public.completed_services cs
    cross join lateral public.paid_ticket_staff_for_entry(cs.id) p
    left join public.manicurists m on m.id = p.staff1_id
    where public.tickets_visit_id(cs.id) = v_visit
      and not coalesce(cs.voided, false)
      and p.staff1_id is distinct from cs.manicurist_id
  ),
  moved as (
    update public.completed_services cs
       set manicurist_id    = w.staff1_id,
           manicurist_name  = w.new_name,
           manicurist_color = w.new_color
      from want w
     where cs.id = w.id
    returning w.*
  )
  insert into public.ticket_tech_moves
    (source, business_date, ticket_number, entry_id, client_name, services,
     from_tech_id, from_tech, to_tech_id, to_tech, old_cents, new_cents)
  select 'live', business_date, ticket_number, id, client_name, services,
         old_id, old_name, staff1_id, new_name, old_cents, cents
  from moved;

  update public.completed_services cs
  set price_cents = (
    select sum(ti.ext_price_cents)
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.status = 'closed'
      and ti.queue_entry_id is not null
      and split_part(ti.queue_entry_id, '#', 1) = cs.id
      and (ti.staff1_id is null or cs.manicurist_id is null
           or ti.staff1_id = cs.manicurist_id)
  )
  where public.tickets_visit_id(cs.id) = v_visit
    and exists (
      select 1
      from public.ticket_items ti
      join public.tickets t on t.id = ti.ticket_id
      where t.status = 'closed'
        and ti.queue_entry_id is not null
        and split_part(ti.queue_entry_id, '#', 1) = cs.id
        and (ti.staff1_id is null or cs.manicurist_id is null
             or ti.staff1_id = cs.manicurist_id)
    );

  update public.completed_services cs
  set price_cents = public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services)
  where public.tickets_visit_id(cs.id) = v_visit
    and cs.id like '%-add-%'
    and public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) is not null;

  update public.completed_services cs
  set price_cents = null
  where public.tickets_visit_id(cs.id) = v_visit
    and cs.price_cents is not null
    and not exists (
      select 1
      from public.ticket_items ti
      join public.tickets t on t.id = ti.ticket_id
      where t.status = 'closed'
        and ti.queue_entry_id is not null
        and split_part(ti.queue_entry_id, '#', 1) = cs.id
        and (ti.staff1_id is null or cs.manicurist_id is null
             or ti.staff1_id = cs.manicurist_id)
    )
    and public.add_child_price_cents(cs.id, cs.manicurist_id, cs.services) is null;
end;
$function$;

-- ── 4. Archived days (and anything left on the live board) ─────────────────
create or replace function public.align_history_to_paid_tickets(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_n   int := 0;
  v_day text;
  v_t   uuid;
begin
  -- Live board: re-run the per-ticket pass for any ticket that disagrees.
  for v_t in
    select distinct p.ticket_id
    from public.completed_services cs
    cross join lateral public.paid_ticket_staff_for_entry(cs.id) p
    where not coalesce(cs.voided, false)
      and p.staff1_id is distinct from cs.manicurist_id
      and p.business_date between p_from and p_to
  loop
    perform public.reprice_completed_services_for_ticket(v_t);
  end loop;

  -- Archive: rewrite the disagreeing entries in place.
  for v_day in
    select dh.date from public.daily_history dh
    where dh.date between to_char(p_from, 'YYYY-MM-DD') and to_char(p_to, 'YYYY-MM-DD')
  loop
    create temp table if not exists _ttm (
      entry_id text primary key, old_id text, old_name text, client_name text,
      services text, old_cents int, staff1_id text, new_name text,
      new_color text, cents int, ticket_number int
    ) on commit drop;
    delete from _ttm;

    insert into _ttm
    select x->>'id', x->>'manicuristId', x->>'manicuristName', x->>'clientName',
           (select string_agg(s, ' + ') from jsonb_array_elements_text(x->'services') s),
           (x->>'priceCents')::int,
           p.staff1_id, coalesce(m.name, p.staff1_name),
           coalesce(m.color, p.staff1_color, x->>'manicuristColor'),
           p.cents, p.ticket_number
    from public.daily_history dh
    cross join lateral jsonb_array_elements(dh.entries) x
    cross join lateral public.paid_ticket_staff_for_entry(x->>'id') p
    left join public.manicurists m on m.id = p.staff1_id
    where dh.date = v_day
      and not coalesce((x->>'voided')::boolean, false)
      and p.staff1_id is distinct from x->>'manicuristId'
    on conflict (entry_id) do nothing;

    continue when not exists (select 1 from _ttm);

    update public.daily_history dh
    set entries = (
      select jsonb_agg(
               case when t.entry_id is null then e.x
                    else e.x || jsonb_build_object(
                           'manicuristId',    t.staff1_id,
                           'manicuristName',  t.new_name,
                           'manicuristColor', t.new_color,
                           'priceCents',      t.cents)
               end order by e.ord)
      from jsonb_array_elements(dh.entries) with ordinality as e(x, ord)
      left join _ttm t on t.entry_id = e.x->>'id'
    )
    where dh.date = v_day;

    insert into public.ticket_tech_moves
      (source, business_date, ticket_number, entry_id, client_name, services,
       from_tech_id, from_tech, to_tech_id, to_tech, old_cents, new_cents)
    select 'archive', v_day::date, ticket_number, entry_id, client_name, services,
           old_id, old_name, staff1_id, new_name, old_cents, cents
    from _ttm;

    v_n := v_n + (select count(*) from _ttm);
  end loop;

  return v_n;
end;
$fn$;

-- ── 5. Run it as part of the repair ────────────────────────────────────────
-- repair_staff_earnings is what both the 23:30 / 00:20 cron chain and the
-- Claude nightly task call, so the alignment rides along with it. Body below
-- is the live definition unchanged apart from the PERFORM at the top.
create or replace function public.repair_staff_earnings(p_from date, p_to date)
 returns table(business_date date, entry_id text, manicurist_name text, client_name text, source text, old_cents integer, new_cents integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_day   date;
begin
  -- The paid ticket decides the tech, before any amount is compared.
  perform public.align_history_to_paid_tickets(p_from, p_to);

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

-- ── 6. Report the moves ────────────────────────────────────────────────────
-- Same definition as before, plus this transaction's ticket_tech_moves folded
-- into `repairs` (tech shown as "HANA -> TAMMY") and counted as repaired.
create or replace function public.nightly_reconcile_earnings(p_force boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_la       timestamp := now() at time zone 'America/Los_Angeles';
  v_to       date;
  v_from     date;
  v_before_n int;
  v_repairs  jsonb;  v_repair_n int;
  v_moves    jsonb;  v_move_n   int;
  v_after    jsonb;  v_after_n  int;  v_after_abs bigint;
begin
  if not p_force and public.la_hour() <> 23 then
    return jsonb_build_object('skipped', true, 'la_hour', public.la_hour());
  end if;

  v_to   := v_la::date;
  v_from := v_to - 1;

  select count(*)::int into v_before_n
    from public.reconcile_staff_earnings(v_from, v_to) r;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date',        x.business_date,
           'ticket',      public.entry_ticket_number(x.entry_id),
           'entry_id',    x.entry_id,
           'client',      x.client_name,
           'tech',        x.manicurist_name,
           'old_cents',   x.old_cents,
           'new_cents',   x.new_cents,
           'delta_cents', (x.new_cents - x.old_cents))
           order by x.business_date, x.manicurist_name), '[]'::jsonb),
         count(*)::int
    into v_repairs, v_repair_n
    from public.repair_staff_earnings(v_from, v_to) x;

  -- now() is fixed for the transaction, so this is exactly the moves made above.
  select coalesce(jsonb_agg(jsonb_build_object(
           'date',        m.business_date,
           'ticket',      m.ticket_number,
           'entry_id',    m.entry_id,
           'client',      m.client_name,
           'tech',        coalesce(m.from_tech, '?') || ' -> ' || coalesce(m.to_tech, '?'),
           'old_cents',   m.old_cents,
           'new_cents',   m.new_cents,
           'delta_cents', (coalesce(m.new_cents,0) - coalesce(m.old_cents,0)),
           'moved',       true)
           order by m.business_date, m.id), '[]'::jsonb),
         count(*)::int
    into v_moves, v_move_n
    from public.ticket_tech_moves m
   where m.moved_at = now();

  v_repairs  := v_moves || v_repairs;
  v_repair_n := v_repair_n + v_move_n;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.business_date desc, abs(r.diff_cents) desc), '[]'::jsonb),
         count(*)::int,
         coalesce(sum(abs(r.diff_cents)), 0)::bigint
    into v_after, v_after_n, v_after_abs
    from public.reconcile_staff_earnings(v_from, v_to) r;

  insert into public.earnings_reconciliation_log
    (from_date, to_date, discrepancies_before, repaired_count, repairs,
     discrepancy_count, total_abs_diff_cents, details)
  values (v_from, v_to, v_before_n, v_repair_n, v_repairs,
          v_after_n, v_after_abs, v_after);

  return jsonb_build_object('from_date', v_from, 'to_date', v_to,
                            'found', v_before_n, 'repaired', v_repair_n,
                            'remaining', v_after_n,
                            'remaining_abs_cents', v_after_abs,
                            'repairs', v_repairs,
                            'remaining_detail', v_after);
end;
$function$;

-- Report wording: a repair can now move a credit, so stop saying it can't.
-- Edited on the stored definition (same no-retype approach as 20260826224500);
-- each phrase occurs exactly once, checked before replacing.
do $do$
declare
  v_def text := pg_get_functiondef('public.nightly_run_finish(bigint)'::regprocedure);
begin
  if (select count(*) from regexp_matches(v_def, 'REPAIRED \(amount only\):', 'g')) <> 1
     or (select count(*) from regexp_matches(v_def, '\(a repair cannot move a credit between techs\)', 'g')) <> 1 then
    raise exception 'nightly_run_finish text changed; update this migration';
  end if;
  v_def := replace(v_def, 'REPAIRED (amount only):', 'REPAIRED (a tech shown as A -> B was moved to match the paid ticket):');
  v_def := replace(v_def, '(a repair cannot move a credit between techs)',
                          '(no paid ticket line settles these)');
  execute v_def;
end
$do$;
