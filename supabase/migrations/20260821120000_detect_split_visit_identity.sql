-- Surface the structural defect behind the 08/20 SAM -$45 loss: a ticket whose
-- header queue_entry_id disagrees with its own lines' visit id.
--
-- How it happens (Leyla Paziranzeh, 08/20, confirmed with the receptionist who
-- was at the desk): check-in writes the appointment status flip and the queue
-- card as two separate actions. When the card does not survive, the block sits
-- at 'checked-in' with nothing behind it and there is no way back — the Q button
-- required status='scheduled' and the Revert control lives on the missing card.
-- The only move left is to delete the appointment and re-book, which mints a
-- FRESH visit id every time. One physical visit then spans several visit ids:
-- the ticket header pins the first, the work lands on the last.
--
-- That mismatch is what actually costs money. It leaves completed_services
-- unpriced (the reprice chain can't match row `<visit>` to line `<visit>#1`),
-- and it puts two tickets on one visit — so voiding the duplicate reaches the
-- row backing the PAID ticket. SAM lost $45 and half a turn that way.
--
-- Detection was chosen by noise-testing three candidates over 30 days:
--   * appointment deleted while checked-in — ~100 hits, several a day. That is
--     routine front-desk behaviour, useless as an alert (but it is why this
--     collision shape gets so many chances to occur).
--   * two non-voided tickets on one client-day — zero hits; the void erases the
--     second ticket, so the evidence is gone by end of day.
--   * header visit id <> line visit id — 5 hits, and it catches BOTH known
--     incidents (08/20 Leyla, 08/13 Katie). This one.
--
-- Note a `#N` suffix on a line is NOT itself a defect: appendItemsToTicket adds
-- it to disambiguate in-batch duplicates, so we compare on split_part(...,'#',1).
-- A `-` suffixed line qid IS legitimate (SPLIT_AND_ASSIGN children hang off the
-- parent visit), so those are excluded too.
create or replace function public.tickets_with_split_visit_identity(
  p_from date,
  p_to   date
)
returns table (
  business_date   date,
  ticket_number   int,
  ticket_id       uuid,
  client_name     text,
  status          text,
  header_visit_id text,
  line_visit_ids  text[]
)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select t.business_date,
         t.ticket_number,
         t.id,
         t.client_name,
         t.status,
         t.queue_entry_id,
         array_agg(distinct split_part(ti.queue_entry_id, '#', 1))
    from public.tickets t
    join public.ticket_items ti on ti.ticket_id = t.id
   where t.business_date between p_from and p_to
     and t.status <> 'voided'          -- a voided ticket needs no action
     and t.queue_entry_id is not null
     and ti.queue_entry_id is not null
   group by 1, 2, 3, 4, 5, 6
  having bool_or(
           split_part(ti.queue_entry_id, '#', 1) <> t.queue_entry_id
       and split_part(ti.queue_entry_id, '#', 1) not like t.queue_entry_id || '-%'
         );
$fn$;

-- Append the new signal to the nightly headline, same shape as the other two:
-- only when non-zero, so a clean night still reads exactly as before.
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
begin
  select * into v_rec from public.nightly_run_report order by started_at desc limit 1;
  if v_rec is null then
    return jsonb_build_object('title','TurnEm nightly','body','no run recorded');
  end if;

  select s->'detail' into v_rc
    from jsonb_array_elements(v_rec.steps) s
   where s->>'step' = 'reconcile_repair' and s->>'status' = 'ok'
   limit 1;

  v_title := format('TurnEm nightly %s - %s',
               to_char(v_rec.business_date,'MM/DD'),
               case when v_rec.ok then 'all ok' else 'NEEDS ATTENTION' end);

  if v_rc is not null then
    v_body := format('%s repaired, %s to check', v_rc->>'repaired', v_rc->>'remaining');
    for v_item in select value from jsonb_array_elements(coalesce(v_rc->'remaining_detail','[]'::jsonb))
    loop
      exit when v_n >= 2;
      v_body := v_body || format('. %s %s%s',
        coalesce(v_item->>'manicurist_name','?'),
        case when (v_item->>'diff_cents')::bigint >= 0 then '+' else '-' end,
        public.cents_text(abs((v_item->>'diff_cents')::bigint)));
      v_n := v_n + 1;
    end loop;
  else
    v_body := 'reconcile step did not complete';
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

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$fn$;
