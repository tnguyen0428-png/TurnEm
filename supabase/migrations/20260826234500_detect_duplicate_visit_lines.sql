-- Detector for the ONE class of billing error every existing check is blind to:
-- the SAME tech billed twice for the same service on the same visit.
--
-- Why nothing else sees it: reconcile compares each tech's board total against
-- their ticket total. When the work is recorded twice on BOTH sides the two
-- agree, so reconcile reports "all ok" - correctly, by its own logic.
--   Christine Ruiz, ticket #15, 2026-08-11: HANA had two board entries at $55
--   (`-mani-8` and `-add-mani-8`) AND two ticket lines at $55. Board $110,
--   tickets $110. Customer overcharged $55, HANA overpaid $55, nothing flagged.
--
-- Contrast the shape reconcile DOES catch: two pedicures where HANA is credited
-- for both and TAMMY for none. There the per-tech totals disagree, so it is
-- reported - though repair will not auto-fix it, because moving credit between
-- techs is left to a human on purpose.
--
-- REPORTS ONLY - never auto-corrects. The rows cannot distinguish a duplicate
-- from a genuine two-person party: ticket #56 (Lily, 2026-08-09) has SAM billed
-- twice at $60 and it is undeterminable from the data whether that is one
-- client or three. Auto-collapsing would have silently undercharged it $60.
--
-- `#N` siblings are the SAME entry billed as separate lines (legitimate
-- multi-service work), so only DISTINCT entry ids count as suspect.
--
-- Volume: 5 hits in the 8 weeks to 2026-08-26, 1 of them a clear duplicate.

create or replace function public.detect_duplicate_visit_lines(p_from date, p_to date)
returns table (
  business_date date,
  ticket_number int,
  client_name text,
  service text,
  staff_name text,
  line_count int,
  prices text,
  all_same_price boolean
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with li as (
    select t.business_date, t.ticket_number, t.client_name,
           ti.name as service, ti.staff1_name, ti.staff1_id,
           coalesce(public.tickets_visit_id(ti.queue_entry_id), ti.queue_entry_id) as visit,
           split_part(ti.queue_entry_id, '#', 1) as entry_id,
           ti.ext_price_cents
    from public.ticket_items ti
    join public.tickets t on t.id = ti.ticket_id
    where t.business_date between p_from and p_to
      and t.status in ('open','closed')
      and ti.queue_entry_id is not null
      and ti.staff1_id is not null
  )
  select li.business_date,
         li.ticket_number,
         max(li.client_name) as client_name,
         li.service,
         max(li.staff1_name) as staff_name,
         count(*)::int as line_count,
         string_agg(public.cents_text(li.ext_price_cents::bigint), ', '
                    order by li.ext_price_cents) as prices,
         (count(distinct li.ext_price_cents) = 1) as all_same_price
  from li
  group by li.business_date, li.ticket_number, li.service, li.staff1_id, li.visit
  having count(distinct li.entry_id) > 1
  order by li.business_date, li.ticket_number;
$function$;

-- Wire it into the 00:20 post-archive job. Appended AFTER nightly_run_finish
-- rather than added as a formatted step, so the shared summary builder (also
-- used by the 23:30 chain) is left untouched.
select cron.schedule(
  'postarchive-reconcile',
  '20 7,8 * * *',
  $cron$
do $do$
declare
  v_run   bigint;
  v_j     jsonb;
  v_day   date;
  v_r     record;
  v_lines text := '';
begin
  if public.la_hour() <> 0 then return; end if;

  v_day := ((now() at time zone 'America/Los_Angeles')::date - 1);

  insert into public.nightly_run_report (business_date)
  values (v_day)
  returning id into v_run;

  begin
    v_j := public.nightly_reconcile_earnings(true);
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'ok', v_j, null);
  exception when others then
    perform public.nightly_run_step(v_run, 'reconcile_repair', 'error', null, sqlerrm);
  end;

  perform public.nightly_run_finish(v_run);

  begin
    for v_r in select * from public.detect_duplicate_visit_lines(v_day, v_day) loop
      v_lines := v_lines || format(E'    #%s  %s  %s  %s x%s  %s%s\n',
        v_r.ticket_number, coalesce(v_r.client_name,'?'), v_r.staff_name,
        v_r.service, v_r.line_count, v_r.prices,
        case when v_r.all_same_price then '   <-- SAME PRICE, likely duplicate' else '' end);
    end loop;
  exception when others then
    v_lines := format(E'    duplicate check FAILED: %s\n', sqlerrm);
  end;

  update public.nightly_run_report
     set summary = replace(summary, 'TurnEm nightly ', 'TurnEm POST-ARCHIVE ')
                   || case when v_lines = ''
                        then E'\n[duplicate check] none\n'
                        else E'\n[duplicate check] same tech billed TWICE for one service on one visit - VERIFY BY HAND:\n' || v_lines
                      end
   where id = v_run;
end
$do$;
  $cron$
);
