-- A written report after every nightly run: what changed, and what broke.
--
-- Until now the four steps shared one transaction, so any failure rolled the
-- whole thing back and left nothing behind to read -- the only trace was a
-- terse row in cron.job_run_details. Each step now runs inside its own
-- exception block and records its own outcome, so a failure is reported
-- instead of vanishing, and one failing step no longer discards the work of
-- the others.
--
-- Read the latest report with:  select public.nightly_report();

create table if not exists public.nightly_run_report (
  id            bigserial primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  business_date date        not null,
  ok            boolean,
  steps         jsonb       not null default '[]'::jsonb,
  summary       text
);

comment on table public.nightly_run_report is
  'One row per nightly chain run. steps is an ordered array of {step, status, detail, error, at}; ok is false if any step errored. summary is the human-readable report.';

create index if not exists nightly_run_report_started_idx
  on public.nightly_run_report (started_at desc);

create or replace function public.nightly_run_begin()
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.nightly_run_report (business_date)
  values ((now() at time zone 'America/Los_Angeles')::date)
  returning id;
$$;

-- Appends one step outcome. Called from inside the step's exception block, so
-- a failure record survives the rollback of the step that produced it.
create or replace function public.nightly_run_step(
  p_run bigint, p_step text, p_status text,
  p_detail jsonb default null, p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.nightly_run_report
     set steps = steps || jsonb_build_object(
                   'step',   p_step,
                   'status', p_status,
                   'detail', p_detail,
                   'error',  p_error,
                   'at',     to_char(now() at time zone 'America/Los_Angeles', 'HH24:MI:SS'))
   where id = p_run;
$$;

-- Renders the report. Deliberately plain text: it is read at 8am on a phone.
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
begin
  select * into v_rec from public.nightly_run_report where id = p_run;

  select count(*) into v_errs
    from jsonb_array_elements(v_rec.steps) s
   where s->>'status' = 'error';

  for v_s in select value from jsonb_array_elements(v_rec.steps)
  loop
    v_lines := v_lines || format(E'  [%s] %-18s %s%s\n',
      v_s->>'at',
      v_s->>'step',
      upper(v_s->>'status'),
      case
        when v_s->>'error' is not null then '  !! ' || (v_s->>'error')
        when v_s->'detail' is not null and v_s->>'detail' <> 'null' then '  ' || (v_s->>'detail')
        else ''
      end);
  end loop;

  update public.nightly_run_report
     set finished_at = now(),
         ok          = (v_errs = 0),
         summary     = format(E'Nightly run for %s — %s\nStarted %s LA, finished %s LA\n\n%s',
                         v_rec.business_date,
                         case when v_errs = 0 then 'ALL OK' else v_errs || ' STEP(S) FAILED' end,
                         to_char(v_rec.started_at at time zone 'America/Los_Angeles', 'HH24:MI:SS'),
                         to_char(now() at time zone 'America/Los_Angeles', 'HH24:MI:SS'),
                         v_lines)
   where id = p_run;
end;
$fn$;

-- The morning read. No arguments: the latest run.
create or replace function public.nightly_report(p_back int default 0)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(summary, 'run started ' || started_at || ' but never finished — check cron.job_run_details')
  from public.nightly_run_report
  order by started_at desc
  offset p_back
  limit 1;
$$;

comment on function public.nightly_report(int) is
  'The latest nightly run report as plain text. p_back = 1 for the night before, and so on.';
