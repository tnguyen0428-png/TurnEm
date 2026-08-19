-- The nightly headline gains the two signals that would have caught 08/15 and
-- 08/18 the next morning instead of three days later:
--   * lines performed after close and never billed (ticket_line_drop_log)
--   * tickets whose payments disagree with their own total
-- Both are appended only when non-zero, so a clean night reads exactly as before.
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

  if not v_rec.ok then
    v_body := v_body || ' | a step FAILED';
  end if;

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$fn$;
