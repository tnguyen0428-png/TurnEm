-- Cross-check the board against the APPOINTMENT BOOK every night.
--
-- The dollar reconcile compares the board (completed_services / daily_history)
-- with the receipt (closed ticket_items). It can say a tech is $55 off, but
-- when the money moved BETWEEN techs, or a paid service was voided on the
-- board, it cannot say which row or who really did the work — and
-- repair_staff_earnings correctly refuses to guess. Both of 2026-09-24/26's
-- discrepancies were settled by hand from the appointment book:
--   09/26  Crystal / Gel Pedicure — booked and completed in LY's column,
--          rung on LY's ticket, but the board entry was edited to KELLY.
--   09/24  Mia / Gel Pedicure — a 9:45 booking, checked in and paid on
--          ticket #9, voided on the board as "no show" four hours later
--          while a second Mia was being rung up.
-- appt_book_mismatches does that check for every entry, every night.
--
-- kind values:
--   WRONG_TECH       the book puts this exact service on a different tech
--                    than the board credits. Only judged when the booking
--                    lists the service — register add-ons that were never
--                    on the book are left to unbilled_add_on_credits.
--   VOIDED_BUT_PAID  voided on the board, but a closed ticket charged for it
--                    and no live entry for the same visit/tech/service
--                    replaced it (a voided duplicate is not reported).

create or replace function public.appt_book_mismatches(p_date date)
returns table (
  business_date  date,
  kind           text,
  entry_id       text,
  client_name    text,
  services       text[],
  board_tech     text,
  book_tech      text,
  ticket_tech    text,
  price_cents    int,
  appointment_id text
)
language sql
stable
security definer
set search_path = public
as $fn$
  with today as (
    select (now() at time zone 'America/Los_Angeles')::date as d
  ),
  -- Entries: the live board for today, the archive for every earlier day,
  -- the same split reconcile_staff_earnings uses.
  ent as (
    select p_date as bd, cs.id, cs.manicurist_id as mani, cs.manicurist_name as mname,
           cs.client_name as cname, to_jsonb(coalesce(cs.services, '{}'::text[])) as svcs,
           cs.price_cents as pc, coalesce(cs.voided, false) as voided,
           cs.original_appointment_id as orig
    from public.completed_services cs, today t
    where p_date = t.d
    union all
    select dh.date::date, x->>'id', x->>'manicuristId', x->>'manicuristName',
           x->>'clientName', coalesce(x->'services', '[]'::jsonb),
           (x->>'priceCents')::int, coalesce((x->>'voided')::boolean, false),
           coalesce(x->>'originalAppointmentId',
                    -- The archive drops the link; the delete log kept the full row.
                    (select d.row_data->>'original_appointment_id'
                       from public.completed_services_delete_log d
                      where d.id = x->>'id'
                      order by d.deleted_at desc limit 1))
    from public.daily_history dh, lateral jsonb_array_elements(dh.entries) x, today t
    where dh.date::date = p_date and dh.date::date <> t.d
  ),
  linked as (
    select e.*,
           coalesce(e.orig,
             (select a.id from public.appointments a
               where a.id in ('walkin:' || e.id, 'walkin:' || public.tickets_visit_id(e.id))
               limit 1),
             (select l.appt_id from public.appointment_delete_log l
               where l.appt_id in ('walkin:' || e.id, 'walkin:' || public.tickets_visit_id(e.id))
               limit 1)) as appt
    from ent e
  ),
  -- The booking as the book last showed it: the live row, or for a booking
  -- since removed, its delete-log row plus its last logged service requests.
  booked as (
    select k.*, b.status as bstatus, b.manicurist_id as bmani, b.sr, b.bsvcs
    from linked k
    left join lateral (
      select a.status, a.manicurist_id, a.service_requests as sr,
             coalesce(a.services, '[]'::jsonb) as bsvcs
        from public.appointments a where a.id = k.appt
      union all
      select * from (
        select l.status, l.manicurist_id,
               (select s.new_service_requests from public.appointment_service_log s
                 where s.appointment_id = l.appt_id order by s.logged_at desc limit 1),
               coalesce(l.services, '[]'::jsonb)
          from public.appointment_delete_log l
         where l.appt_id = k.appt
           and not exists (select 1 from public.appointments a where a.id = k.appt)
         order by l.deleted_at desc limit 1) z
      limit 1
    ) b on true
  ),
  judged as (
    select k.*,
           -- Who the book puts on THIS entry's services. Null = the book does
           -- not list the service, so there is nothing to judge against.
           case
             when exists (select 1 from jsonb_array_elements(coalesce(k.sr, '[]'::jsonb)) r
                           where k.svcs ? (r->>'service'))
               then (select array_agg(distinct m)
                       from jsonb_array_elements(k.sr) r,
                            jsonb_array_elements_text(r->'manicuristIds') m
                      where k.svcs ? (r->>'service'))
             when jsonb_array_length(coalesce(k.sr, '[]'::jsonb)) = 0
                  and k.bmani is not null and k.bsvcs ?| array(select jsonb_array_elements_text(k.svcs))
               then array[k.bmani]
           end as book_techs,
           (select string_agg(distinct ti.staff1_name, '/')
              from public.ticket_items ti
              join public.tickets t on t.id = ti.ticket_id
             where split_part(ti.queue_entry_id, '#', 1) = k.id
               and t.status in ('open', 'closed')) as tix_tech,
           exists (select 1
                     from public.ticket_items ti
                     join public.tickets t on t.id = ti.ticket_id
                    where split_part(ti.queue_entry_id, '#', 1) = k.id
                      and t.status = 'closed' and t.business_date = p_date
                      and ti.kind = 'service' and ti.ext_price_cents > 0) as paid
    from booked k
  )
  select j.bd,
         case when j.voided then 'VOIDED_BUT_PAID' else 'WRONG_TECH' end,
         j.id, j.cname,
         (select array_agg(v) from jsonb_array_elements_text(j.svcs) v),
         j.mname,
         (select string_agg(m.name, '/' order by m.name) from public.manicurists m
           where m.id = any(coalesce(j.book_techs, array[j.bmani]))),
         j.tix_tech, j.pc, j.appt
  from judged j
  where (not j.voided
         and j.book_techs is not null
         and not (j.mani = any(j.book_techs)))
     or (j.voided
         and j.paid
         and not exists (select 1 from ent e2
                          where not e2.voided
                            and e2.mani = j.mani
                            and public.tickets_visit_id(e2.id) = public.tickets_visit_id(j.id)
                            and e2.svcs ?| array(select jsonb_array_elements_text(j.svcs))))
  order by 1, 2, j.mname, j.cname;
$fn$;

comment on function public.appt_book_mismatches(date) is
  'Board entries the appointment book contradicts: WRONG_TECH (book puts the service on another tech) and VOIDED_BUT_PAID (voided on the board, charged on a closed ticket, not replaced). Live table for today, daily_history for earlier dates.';


-- ── Push body: add the count ───────────────────────────────────────────────
create or replace function public.nightly_push_body()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_rec   record;
  v_rc    jsonb;
  v_title text;
  v_body  text := '';
  v_item  jsonb;
  v_n     int := 0;
  v_late  int := 0;
  v_unb   int := 0;
  v_split int := 0;
  v_addon int := 0;
  v_book  int := 0;
  v_from  date;
  v_to    date;
  v_rem   int := 0;
begin
  select * into v_rec from public.nightly_run_report order by started_at desc limit 1;
  if v_rec is null then
    return jsonb_build_object('title','TurnEm nightly','body','no run recorded');
  end if;

  select s->'detail' into v_rc
    from jsonb_array_elements(v_rec.steps) s
   where s->>'step' = 'reconcile_repair' and s->>'status' = 'ok'
   limit 1;

  v_from := coalesce((v_rc->>'from_date')::date, v_rec.business_date - 1);
  v_to   := coalesce((v_rc->>'to_date')::date,   v_rec.business_date);
  v_rem  := coalesce((v_rc->>'remaining')::int, 0);

  if v_rc is not null then
    v_body := format('checked %s-%s: %s repaired, %s to check',
                to_char(v_from,'MM/DD'), to_char(v_to,'MM/DD'),
                v_rc->>'repaired', v_rc->>'remaining');
    for v_item in select value from jsonb_array_elements(coalesce(v_rc->'remaining_detail','[]'::jsonb))
    loop
      exit when v_n >= 2;
      v_body := v_body || format('. %s %s %s%s (board %s vs tickets %s)',
        to_char((v_item->>'business_date')::date,'MM/DD'),
        coalesce(v_item->>'manicurist_name','?'),
        case when (v_item->>'diff_cents')::bigint >= 0 then '+' else '-' end,
        public.cents_text(abs((v_item->>'diff_cents')::bigint)),
        public.cents_text((v_item->>'portal_cents')::bigint),
        public.cents_text((v_item->>'blueprint_cents')::bigint));
      v_n := v_n + 1;
    end loop;
    if jsonb_array_length(coalesce(v_rc->'remaining_detail','[]'::jsonb)) > v_n then
      v_body := v_body || format('. +%s more',
        jsonb_array_length(v_rc->'remaining_detail') - v_n);
    end if;
  else
    v_body := 'reconcile step did not complete';
  end if;

  select count(*) into v_addon
    from (select * from public.unbilled_add_on_credits(v_from)
          union all
          select * from public.unbilled_add_on_credits(v_to)) a;
  if v_addon > 0 then
    v_body := v_body || format(' | %s add-on credit%s with NO ticket line',
                               v_addon, case when v_addon = 1 then '' else 's' end);
  end if;

  select count(*) into v_book
    from (select * from public.appt_book_mismatches(v_from)
          union all
          select * from public.appt_book_mismatches(v_to)) b;
  if v_book > 0 then
    v_body := v_body || format(' | %s entr%s the appt book disagrees with',
                               v_book, case when v_book = 1 then 'y' else 'ies' end);
  end if;

  select count(*) into v_late from public.unbilled_dropped_lines(v_rec.business_date);
  if v_late > 0 then
    v_body := v_body || format(' | %s line%s performed after close, NOT BILLED',
                               v_late, case when v_late = 1 then '' else 's' end);
  end if;

  select count(*) into v_unb from public.unbalanced_tickets(v_rec.business_date, v_rec.business_date);
  if v_unb > 0 then
    v_body := v_body || format(' | %s ticket%s off balance',
                               v_unb, case when v_unb = 1 then '' else 's' end);
  end if;

  select count(*) into v_split
    from public.tickets_with_split_visit_identity(v_rec.business_date, v_rec.business_date);
  if v_split > 0 then
    v_body := v_body || format(' | %s ticket%s on a split visit id',
                               v_split, case when v_split = 1 then '' else 's' end);
  end if;

  if not v_rec.ok then
    v_body := v_body || ' | a step FAILED';
  end if;

  v_title := format('TurnEm nightly %s - %s',
               to_char(v_rec.business_date,'MM/DD'),
               case when v_rec.ok and v_rem = 0 and v_addon = 0 and v_book = 0
                     and v_late = 0 and v_unb = 0 and v_split = 0
                    then 'all ok' else 'NEEDS ATTENTION' end);

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$fn$;


-- ── Long summary: name each row the book contradicts ───────────────────────
create or replace function public.nightly_run_finish(p_run bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rec   record;
  v_errs  int;
  v_lines text := '';
  v_s     jsonb;
  v_d     jsonb;
  v_item  jsonb;
  v_rc    jsonb;
  v_from  date;
  v_to    date;
  v_addon record;
  v_addn  int := 0;
  v_bk    record;
  v_bkn   int := 0;
  v_hdr   text;
begin
  select * into v_rec from public.nightly_run_report where id = p_run;

  select count(*) into v_errs
    from jsonb_array_elements(v_rec.steps) s
   where s->>'status' = 'error';

  select s->'detail' into v_rc
    from jsonb_array_elements(v_rec.steps) s
   where s->>'step' = 'reconcile_repair' and s->>'status' = 'ok'
   limit 1;
  v_from := coalesce((v_rc->>'from_date')::date, v_rec.business_date - 1);
  v_to   := coalesce((v_rc->>'to_date')::date,   v_rec.business_date);

  for v_s in select value from jsonb_array_elements(v_rec.steps)
  loop
    v_d := v_s->'detail';

    if v_s->>'status' = 'error' then
      v_lines := v_lines || format(E'[%s] %s FAILED\n    !! %s\n',
                   v_s->>'at', v_s->>'step', v_s->>'error');

    elsif v_s->>'step' = 'reconcile_repair' then
      v_lines := v_lines || format(E'[%s] reconcile of %s..%s: found %s, repaired %s, still off %s\n',
                   v_s->>'at',
                   to_char(v_from,'MM/DD'), to_char(v_to,'MM/DD'),
                   v_d->>'found', v_d->>'repaired', v_d->>'remaining');

      if jsonb_array_length(coalesce(v_d->'repairs','[]'::jsonb)) > 0 then
        v_lines := v_lines || E'  REPAIRED (amount only):\n';
        for v_item in select value from jsonb_array_elements(v_d->'repairs')
        loop
          v_lines := v_lines || format(E'    ticket #%s %s  %s / %s  %s -> %s (%s%s)\n',
            coalesce(v_item->>'ticket','?'),
            v_item->>'date',
            coalesce(v_item->>'client','?'),
            coalesce(v_item->>'tech','?'),
            public.cents_text((v_item->>'old_cents')::bigint),
            public.cents_text((v_item->>'new_cents')::bigint),
            case when (v_item->>'delta_cents')::bigint >= 0 then '+' else '-' end,
            public.cents_text(abs((v_item->>'delta_cents')::bigint)));
        end loop;
      end if;

      if jsonb_array_length(coalesce(v_d->'remaining_detail','[]'::jsonb)) > 0 then
        v_lines := v_lines || E'  STILL OFF - check by hand (a repair cannot move a credit between techs):\n';
        for v_item in select value from jsonb_array_elements(v_d->'remaining_detail')
        loop
          v_lines := v_lines || format(E'    BUSINESS DATE %s  %s  board %s vs tickets %s = %s%s%s\n',
            to_char((v_item->>'business_date')::date,'MM/DD (Dy)'),
            coalesce(v_item->>'manicurist_name','?'),
            public.cents_text((v_item->>'portal_cents')::bigint),
            public.cents_text((v_item->>'blueprint_cents')::bigint),
            case when (v_item->>'diff_cents')::bigint >= 0 then '+' else '-' end,
            public.cents_text(abs((v_item->>'diff_cents')::bigint)),
            case when coalesce((v_item->>'open_ticket_cents')::bigint,0) <> 0
                 then ' (unpaid ' || public.cents_text((v_item->>'open_ticket_cents')::bigint) || ')'
                 else '' end);
        end loop;
      end if;

    elsif v_s->>'step' = 'prune_history' then
      v_lines := v_lines || format(E'[%s] pruned %s old history row(s)\n',
                   v_s->>'at', v_d->>'rows_deleted');

    elsif v_s->>'step' = 'board_reset' then
      v_lines := v_lines || format(E'[%s] board reset: cleared %s, archived %s date(s)\n',
                   v_s->>'at', v_d->>'cleared', v_d->>'archived_dates');

    else
      v_lines := v_lines || format(E'[%s] %s %s\n',
                   v_s->>'at', v_s->>'step', upper(v_s->>'status'));
    end if;
  end loop;

  for v_addon in
    select * from public.unbilled_add_on_credits(v_from)
    union all
    select * from public.unbilled_add_on_credits(v_to)
  loop
    if v_addn = 0 then
      v_lines := v_lines || E'\n  ADD-ON CREDITS WITH NO TICKET LINE (tech is paid, client was not charged):\n';
    end if;
    v_addn := v_addn + 1;
    v_lines := v_lines || format(E'    BUSINESS DATE %s  %s / %s  %s  %s\n      void the credit, or add the line and re-ring. entry %s\n',
      to_char(v_addon.business_date,'MM/DD (Dy)'),
      coalesce(v_addon.client_name,'?'),
      coalesce(v_addon.manicurist_name,'?'),
      coalesce(array_to_string(v_addon.services, ' + '), '?'),
      case when v_addon.price_cents is not null
           then public.cents_text(v_addon.price_cents)
           else 'unpriced, catalog ' || public.cents_text(v_addon.catalog_cents) end,
      v_addon.entry_id);
  end loop;

  -- The appointment book as the tie-breaker. This names the row behind a
  -- "KELLY +$55 / LY -$55" pair, and says who the book had doing it.
  for v_bk in
    select * from public.appt_book_mismatches(v_from)
    union all
    select * from public.appt_book_mismatches(v_to)
  loop
    if v_bkn = 0 then
      v_lines := v_lines || E'\n  APPT BOOK DISAGREES WITH THE BOARD:\n';
    end if;
    v_bkn := v_bkn + 1;
    if v_bk.kind = 'WRONG_TECH' then
      v_lines := v_lines || format(E'    BUSINESS DATE %s  %s  %s  board credits %s, book has %s, ticket %s\n      move the credit if the book is right. entry %s\n',
        to_char(v_bk.business_date,'MM/DD (Dy)'),
        coalesce(v_bk.client_name,'?'),
        coalesce(array_to_string(v_bk.services, ' + '), '?'),
        coalesce(v_bk.board_tech,'?'),
        coalesce(v_bk.book_tech,'?'),
        coalesce(v_bk.ticket_tech,'none'),
        v_bk.entry_id);
    else
      v_lines := v_lines || format(E'    BUSINESS DATE %s  %s  %s  VOIDED on %s''s board but paid on ticket (book: %s)\n      un-void if the service happened. entry %s\n',
        to_char(v_bk.business_date,'MM/DD (Dy)'),
        coalesce(v_bk.client_name,'?'),
        coalesce(array_to_string(v_bk.services, ' + '), '?'),
        coalesce(v_bk.board_tech,'?'),
        coalesce(v_bk.book_tech,'not found'),
        v_bk.entry_id);
    end if;
  end loop;

  v_hdr := format('TurnEm nightly - run %s, covering %s..%s - %s',
             to_char(v_rec.business_date, 'MM/DD'),
             to_char(v_from, 'MM/DD'), to_char(v_to, 'MM/DD'),
             case when v_errs > 0 then v_errs || ' STEP(S) FAILED'
                  when coalesce((v_rc->>'remaining')::int, 0) > 0 or v_addn > 0 or v_bkn > 0
                    then format('NEEDS ATTENTION (%s tech day(s) off, %s unbilled add-on(s), %s appt book mismatch(es))',
                                coalesce((v_rc->>'remaining')::int, 0), v_addn, v_bkn)
                  else 'all ok' end);

  update public.nightly_run_report
     set finished_at = now(),
         ok          = (v_errs = 0),
         summary     = format(E'%s\n\n%s', v_hdr, v_lines)
   where id = p_run;
end;
$fn$;
