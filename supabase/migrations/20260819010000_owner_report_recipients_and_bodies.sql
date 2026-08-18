-- Owner-level notifications: who gets them, and what they say.
--
-- Web push is a HEADLINE medium -- a notification shows two or three short
-- lines. So the push carries the verdict and the worst offenders, and the full
-- ticket-level report stays in nightly_report(). The push tells you whether
-- you need to go look.
--
-- NOTE: an earlier version of this migration also created an app_secrets table
-- holding the bearer token, so a database trigger could authenticate to
-- send-push. That was rejected -- copying a credential into a new table is not
-- something to do quietly. The nightly push instead reuses the headers already
-- present in the cron command, and the shift-close push is sent by the app,
-- which is already authenticated when it closes the drawer.

create table if not exists public.report_push_recipients (
  push_id text primary key,
  label   text,
  active  boolean not null default true
);

insert into public.report_push_recipients (push_id, label)
values ('owner-tony', 'owner phone')
on conflict (push_id) do update set active = true;

comment on table public.report_push_recipients is
  'Recipients of owner-level pushes (nightly report, shift-close sales). push_id matches push_subscriptions.manicurist_id; a synthetic id keeps the owner off the board and out of the turn rotation.';

-- The nightly headline: verdict, then the two worst unexplained gaps.
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

  if not v_rec.ok then
    v_body := v_body || ' | a step FAILED';
  end if;

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$fn$;

-- Sales totals for one shift, for the notification sent when the drawer closes.
create or replace function public.shift_sales_summary(p_shift uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (select * from public.shifts where id = p_shift),
  tix as (
    select t.id, t.total_cents, t.tip_cents, t.tax_cents, t.discount_cents
    from public.tickets t, s
    where t.shift_id = s.id and t.status = 'closed'
  ),
  lines as (
    select ti.kind, sum(ti.unit_price_cents * ti.quantity - coalesce(ti.discount_cents,0)) as cents
    from public.ticket_items ti
    join tix on tix.id = ti.ticket_id
    group by 1
  )
  select jsonb_build_object(
    'business_date', (select business_date from s),
    'drawer',        (select drawer_number from s),
    'tickets',       (select count(*) from tix),
    'service_cents', coalesce((select cents from lines where kind = 'service'), 0),
    'retail_cents',  coalesce((select sum(cents) from lines where kind <> 'service'), 0),
    'tips_cents',    coalesce((select sum(tip_cents) from tix), 0),
    'tax_cents',     coalesce((select sum(tax_cents) from tix), 0),
    'total_cents',   coalesce((select sum(total_cents) from tix), 0),
    'variance_cents',(select variance_cents from s),
    'declared_cash_cents', (select declared_cash_cents from s),
    'expected_cash_cents', (select expected_cash_cents from s)
  );
$$;

comment on function public.shift_sales_summary(uuid) is
  'Sales totals for one shift: closed-ticket count, service vs retail, tips, tax, grand total, and the drawer variance. Used by the shift-close notification.';
