-- Ticket-level detail in the nightly report, so every automatic change can be
-- checked by hand against the register.
--
-- IMPORTANT about what "repair" means: repair_staff_earnings only ever rewrites
-- price_cents to match that tech's own ticket receipt. It NEVER reassigns a
-- manicurist. The report therefore has two distinct sections:
--   REPAIRED   - amounts changed, with the ticket number to check against
--   STILL OFF  - portal and blueprint disagree and the repair could not prove
--                the fix. A credit sitting on the wrong tech shows up HERE,
--                never in REPAIRED, and always needs a human.

-- The human-facing ticket number behind an entry. An entry maps to a visit; a
-- visit can carry more than one ticket, so prefer the closed one.
create or replace function public.entry_ticket_number(p_entry_id text)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select t.ticket_number
  from public.tickets t
  where t.queue_entry_id = public.tickets_visit_id(p_entry_id)
  order by (t.status = 'closed') desc, t.closed_at desc nulls last
  limit 1;
$$;

-- Money for humans: 5500 -> $55.00
create or replace function public.cents_text(p_cents bigint)
returns text
language sql
immutable
as $$ select '$' || to_char(coalesce(p_cents,0) / 100.0, 'FM999999990.00'); $$;

-- Reconcile, repair, reconcile again -- now returning the detail of both.
create or replace function public.nightly_reconcile_earnings(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_la       timestamp := now() at time zone 'America/Los_Angeles';
  v_to       date;
  v_from     date;
  v_before_n int;
  v_repairs  jsonb;  v_repair_n int;
  v_after    jsonb;  v_after_n  int;  v_after_abs bigint;
begin
  if not p_force and public.la_hour() <> 23 then
    return jsonb_build_object('skipped', true, 'la_hour', public.la_hour());
  end if;

  v_to   := v_la::date;
  v_from := v_to - 1;

  select count(*)::int into v_before_n
    from public.reconcile_staff_earnings(v_from, v_to) r;

  -- Each repair carries the ticket number, client, tech and exact before/after.
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
$fn$;

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
begin
  select * into v_rec from public.nightly_run_report where id = p_run;

  select count(*) into v_errs
    from jsonb_array_elements(v_rec.steps) s
   where s->>'status' = 'error';

  for v_s in select value from jsonb_array_elements(v_rec.steps)
  loop
    v_d := v_s->'detail';

    if v_s->>'status' = 'error' then
      v_lines := v_lines || format(E'[%s] %s FAILED\n    !! %s\n',
                   v_s->>'at', v_s->>'step', v_s->>'error');

    elsif v_s->>'step' = 'reconcile_repair' then
      v_lines := v_lines || format(E'[%s] reconcile: found %s, repaired %s, still off %s\n',
                   v_s->>'at', v_d->>'found', v_d->>'repaired', v_d->>'remaining');

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
          v_lines := v_lines || format(E'    %s %s  board %s vs tickets %s = %s%s%s\n',
            v_item->>'business_date',
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

  update public.nightly_run_report
     set finished_at = now(),
         ok          = (v_errs = 0),
         summary     = format(E'TurnEm nightly %s - %s\n\n%s',
                         to_char(v_rec.business_date, 'MM/DD'),
                         case when v_errs = 0 then 'all ok' else v_errs || ' STEP(S) FAILED' end,
                         v_lines)
   where id = p_run;
end;
$fn$;
