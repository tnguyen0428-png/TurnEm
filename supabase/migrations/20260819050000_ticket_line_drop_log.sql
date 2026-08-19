-- Dropped ticket lines stop being invisible.
--
-- Three BEFORE INSERT triggers on ticket_items end the same way: RAISE NOTICE
-- then RETURN NULL. The row is cancelled, the notice goes to the Postgres
-- server log, and PostgREST answers 200 -- so the app believes the write landed
-- and the cashier sees nothing. That is how LEO's $55.00 Gel Pedicure (Penny,
-- 08/18) disappeared while her $55.00 cash was accepted: payments carry no such
-- guard, so the money went in and the line that explained it did not.
--
-- The drop behaviour is CORRECT -- a settled ticket must not grow new lines.
-- What was missing is the receipt for it. Each trigger now records what it
-- dropped, and the register + the nightly push read that record.
create table if not exists public.ticket_line_drop_log (
  id               bigserial primary key,
  dropped_at       timestamptz not null default now(),
  ticket_id        uuid,
  ticket_number    int,
  business_date    date,
  ticket_status    text,
  source           text not null,
  service          text,
  manicurist_id    text,
  manicurist_name  text,
  queue_entry_id   text,
  unit_price_cents int,
  resolved         boolean not null default false,
  resolved_at      timestamptz
);

create index if not exists idx_ticket_line_drop_log_open
  on public.ticket_line_drop_log (business_date, resolved);

comment on table public.ticket_line_drop_log is
  'Every ticket_items insert cancelled by a guard trigger. source = which guard. A row with resolved=false and source like ''closed%'' is work that was performed and never billed.';

-- The ensure_rls event trigger enables RLS on every new table; with no policies
-- the register reads an empty list and we are back to a silent failure. See
-- 20260819030000 for the last time that happened.
alter table public.ticket_line_drop_log enable row level security;

drop policy if exists "read ticket_line_drop_log" on public.ticket_line_drop_log;
drop policy if exists "insert ticket_line_drop_log" on public.ticket_line_drop_log;
drop policy if exists "resolve ticket_line_drop_log" on public.ticket_line_drop_log;

create policy "read ticket_line_drop_log" on public.ticket_line_drop_log
  for select to anon, authenticated using (true);
-- the guard triggers run as the invoker, so the register's role must be able to
-- write the record of its own dropped line
create policy "insert ticket_line_drop_log" on public.ticket_line_drop_log
  for insert to anon, authenticated with check (true);
create policy "resolve ticket_line_drop_log" on public.ticket_line_drop_log
  for update to anon, authenticated using (true) with check (true);

-- One writer for all three guards. Never raises: a failure to log must not take
-- down the insert path it is observing.
create or replace function public.log_dropped_ticket_line(
  p_source text, p_ticket_id uuid, p_status text, p_name text,
  p_staff_id text, p_staff_name text, p_qid text, p_price int)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_num  int;
  v_date date;
begin
  begin
    select ticket_number, business_date into v_num, v_date
      from public.tickets where id = p_ticket_id;
    insert into public.ticket_line_drop_log
      (ticket_id, ticket_number, business_date, ticket_status, source,
       service, manicurist_id, manicurist_name, queue_entry_id, unit_price_cents)
    values
      (p_ticket_id, v_num, v_date, p_status, p_source,
       p_name, p_staff_id, p_staff_name, p_qid, p_price);
  exception when others then
    null;
  end;
end;
$fn$;

-- ── the three guards, unchanged except that they now leave a record ──────────

create or replace function public.reject_ticket_items_on_closed_ticket_unconditional()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM public.tickets
  WHERE id = NEW.ticket_id
  FOR SHARE;

  IF parent_status IN ('closed', 'voided') THEN
    PERFORM public.log_dropped_ticket_line(
      'closed_unconditional', NEW.ticket_id, parent_status, NEW.name,
      NEW.staff1_id, NEW.staff1_name, NEW.queue_entry_id, NEW.ext_price_cents);
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

create or replace function public.silently_skip_ticket_items_on_closed_ticket()
returns trigger
language plpgsql
as $function$
DECLARE
  parent_status text;
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RETURN NEW;
  END IF;

  SELECT status INTO parent_status
    FROM tickets
   WHERE id = NEW.ticket_id
     FOR SHARE;

  IF parent_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF parent_status <> 'open' THEN
    PERFORM public.log_dropped_ticket_line(
      'closed_cascaded', NEW.ticket_id, parent_status, NEW.name,
      NEW.staff1_id, NEW.staff1_name, NEW.queue_entry_id, NEW.ext_price_cents);
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

create or replace function public.silently_skip_ticket_items_with_add_child_qid()
returns trigger
language plpgsql
as $function$
BEGIN
  IF NEW.queue_entry_id IS NOT NULL
     AND position('-add-' in NEW.queue_entry_id) > 0
  THEN
    -- Structural, not a loss: TicketModal owns these lines and writes them
    -- under the bare visit id. Logged for diagnosis, excluded from the
    -- needs-billing view below.
    PERFORM public.log_dropped_ticket_line(
      'add_child_qid', NEW.ticket_id, null, NEW.name,
      NEW.staff1_id, NEW.staff1_name, NEW.queue_entry_id, NEW.ext_price_cents);
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

-- Work performed and never billed, for one business date.
create or replace function public.unbilled_dropped_lines(p_date date)
returns setof public.ticket_line_drop_log
language sql
stable
security definer
set search_path to 'public'
as $$
  select * from public.ticket_line_drop_log
   where business_date = p_date
     and not resolved
     and source like 'closed%'
   order by dropped_at;
$$;

-- Tickets that collected an amount different from what they say they are owed.
-- The register now blocks this, but the register is one client among several --
-- this holds regardless of which build is running.
create or replace function public.unbalanced_tickets(p_from date, p_to date)
returns table (business_date date, ticket_number int, client_name text,
               total_cents int, payments_cents bigint, diff_cents bigint)
language sql
stable
security definer
set search_path to 'public'
as $$
  select t.business_date, t.ticket_number, t.client_name,
         t.total_cents, sum(p.amount_cents), sum(p.amount_cents) - t.total_cents
  from public.tickets t
  join public.payments p on p.ticket_id = t.id
  where t.business_date between p_from and p_to
    and t.status = 'closed'
  group by t.id, t.business_date, t.ticket_number, t.client_name, t.total_cents
  having sum(p.amount_cents) <> t.total_cents
  order by t.business_date, t.ticket_number;
$$;
