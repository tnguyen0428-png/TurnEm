-- Two problems, both surfaced by CHRISTINA × Nail Art × Jenifer (2026-08-31).
--
-- 1. NOTHING DETECTED THE SHAPE. A cashier "+ Add line" writes a tech's turn
--    credit to a synthetic add-child (`${visit}-add-${staffId}`). When the
--    service later left the book, the credit stayed. The reconciler caught the
--    dollar total, but only as "CHRISTINA is $5 off" — it could not say WHY,
--    and repair_staff_earnings correctly refused to guess (there is no receipt
--    line to price from). unbilled_add_on_credits names the actual row.
--
-- 2. THE REPORT DID NOT SAY WHICH DAY. The push read
--    `TurnEm nightly 09/02 - NEEDS ATTENTION | CHRISTINA +$5.00`. The title
--    carries the RUN date; the discrepancy was for 08/31. Two nights running
--    the same alert arrived with no business date on it, and it was reasonably
--    read as "yesterday". Every discrepancy line now carries its own date, and
--    both surfaces state the range actually checked.

-- ── 1. Detector ────────────────────────────────────────────────────────────
-- An add-on credit with no ticket line for that tech on that visit: work the
-- board pays for and no receipt ever charged. Reads live completed_services
-- for today and the archive for any earlier date, matching how
-- reconcile_staff_earnings sources its two halves.
create or replace function public.unbilled_add_on_credits(p_date date)
returns table (
  business_date   date,
  entry_id        text,
  manicurist_id   text,
  manicurist_name text,
  client_name     text,
  services        text[],
  price_cents     int,
  catalog_cents   bigint
)
language sql
stable
security definer
set search_path = public
as $fn$
  with today as (
    select (now() at time zone 'America/Los_Angeles')::date as d
  ),
  ent as (
    select p_date as bd,
           cs.id,
           public.tickets_visit_id(cs.id) as visit,
           cs.manicurist_id   as mani,
           cs.manicurist_name as mname,
           cs.client_name     as cname,
           cs.services        as svcs,
           cs.price_cents     as pc
    from public.completed_services cs, today t
    where p_date = t.d
      and coalesce(cs.voided, false) = false
      and cs.id like '%-add-%'
    union all
    select dh.date::date,
           x->>'id',
           public.tickets_visit_id(x->>'id'),
           x->>'manicuristId',
           x->>'manicuristName',
           x->>'clientName',
           (select array_agg(v) from jsonb_array_elements_text(x->'services') v),
           (x->>'priceCents')::int
    from public.daily_history dh, lateral jsonb_array_elements(dh.entries) x, today t
    where dh.date::date = p_date
      and dh.date::date <> t.d
      and coalesce((x->>'voided')::boolean, false) = false
      and (x->>'id') like '%-add-%'
  ),
  lines as (
    select coalesce(public.tickets_visit_id(ti.queue_entry_id), ti.queue_entry_id) as visit,
           ti.staff1_id as mani,
           count(*) as n
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.business_date = p_date
      and ti.kind = 'service'
      and t.status in ('open', 'closed')
      and ti.staff1_id is not null
    group by 1, 2
  )
  select e.bd, e.id, e.mani, e.mname, e.cname, e.svcs, e.pc,
         (select coalesce(sum(round(ss.price * 100)), 0)::bigint
            from unnest(coalesce(e.svcs, '{}'::text[])) s
            left join public.salon_services ss on ss.name = s)
  from ent e
  left join lines l on l.visit = e.visit and l.mani = e.mani
  where l.n is null
  order by e.bd, e.mname, e.id;
$fn$;

comment on function public.unbilled_add_on_credits(date) is
  'Add-on turn credits (`${visit}-add-${staff}` rows) with no ticket line for that tech on that visit — work the board pays for that no receipt charged. Live table for today, daily_history for earlier dates.';

-- ── 2a. Push body: date every discrepancy, name the range ──────────────────
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
    -- Say what was checked. Without this the only date on the notification is
    -- the run date in the title, and a discrepancy carried over from an
    -- earlier business day reads as if it happened yesterday.
    v_body := format('checked %s-%s: %s repaired, %s to check',
                to_char(v_from,'MM/DD'), to_char(v_to,'MM/DD'),
                v_rc->>'repaired', v_rc->>'remaining');
    for v_item in select value from jsonb_array_elements(coalesce(v_rc->'remaining_detail','[]'::jsonb))
    loop
      exit when v_n >= 2;
      -- Business date FIRST on every line — this is the field whose absence
      -- made 08/31's discrepancy read as 09/01 two mornings in a row.
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

  -- Title LAST, so it can reflect the findings and not just whether a step
  -- threw. `ok` means "no step errored" — a run that cleanly finds a $5
  -- discrepancy is ok by that definition, and the old title said "all ok"
  -- directly above a body reporting the problem. Anything a human has to
  -- act on now says NEEDS ATTENTION.
  v_title := format('TurnEm nightly %s - %s',
               to_char(v_rec.business_date,'MM/DD'),
               case when v_rec.ok and v_rem = 0 and v_addon = 0
                     and v_late = 0 and v_unb = 0 and v_split = 0
                    then 'all ok' else 'NEEDS ATTENTION' end);

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$fn$;

-- ── 2b. Long summary: state the range, spell out each discrepancy ──────────
-- The add-on section is computed here rather than wired in as a chain step, so
-- it needs no edit to the stored cron command to start reporting.
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
          -- BUSINESS DATE is spelled out, not just printed as a bare column.
          -- A carried-over discrepancy is the common case (it survives every
          -- run until a human clears it), so the date has to be unmissable.
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

  -- Unbilled add-on credits. This is the WHY behind a reconcile difference of
  -- this shape: a tech credited for an add-on that no ticket line ever
  -- charged. Named per row so the morning does not start with a hunt.
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

  -- Same reasoning as the push title: a run whose steps all succeeded while
  -- leaving a real discrepancy on the board is NOT "all ok", and saying so at
  -- the top is what stops the detail below being skimmed past.
  v_hdr := format('TurnEm nightly - run %s, covering %s..%s - %s',
             to_char(v_rec.business_date, 'MM/DD'),
             to_char(v_from, 'MM/DD'), to_char(v_to, 'MM/DD'),
             case when v_errs > 0 then v_errs || ' STEP(S) FAILED'
                  when coalesce((v_rc->>'remaining')::int, 0) > 0 or v_addn > 0
                    then format('NEEDS ATTENTION (%s tech day(s) off, %s unbilled add-on(s))',
                                coalesce((v_rc->>'remaining')::int, 0), v_addn)
                  else 'all ok' end);

  update public.nightly_run_report
     set finished_at = now(),
         ok          = (v_errs = 0),
         summary     = format(E'%s\n\n%s', v_hdr, v_lines)
   where id = p_run;
end;
$fn$;
