-- daily_history's BEFORE trigger dropped a real, paid turn.
--
-- KATELYN, 09/23 (ticket #3, Erinn, two Gel Pedicures — MACY + KATELYN):
--   board rows `de17ad82…-mani-17` and `de17ad82…-mani-9` share a visit, so they
--   share started_at. The -mani-17 row had been reassigned to KATELYN and then
--   voided as a duplicate — leaving two rows with the same startedAt AND the same
--   manicuristId. deduplicate_history_entries() keys on exactly that pair and
--   keeps the FIRST one seen. The archive orders by clock-in time; the voided row
--   still carried MACY's earlier clock-in, so it sorted first and the live $55 row
--   was discarded. Live board at 23:30 was right; the archive was $55 short, and
--   the 00:20 post-archive reconcile flagged KATELYN -$55.
--
-- This trigger was created out-of-band (never in a migration). Its premise —
-- "duplicates share the exact same startedAt" — stopped holding once visits
-- split into per-tech children that are started together. Every archive writer
-- (scheduled_morning_reset, nightly-save-history, the client save) already
-- builds or merges entries by id, so the id IS the identity.
--
-- New rule: collapse only
--   1. repeats of the same entry id, and
--   2. rows with different ids that are otherwise indistinguishable (same
--      startedAt, tech, client, services, price, voided) — the legacy
--      re-insert duplicates the old trigger was written for.
-- A voided row can never shadow a live one, and two differently-priced rows
-- are never merged, so this can only keep a row the old rule dropped.

create or replace function public.deduplicate_history_entries()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  entry       jsonb;
  seen_ids    text[] := array[]::text[];
  seen_shapes text[] := array[]::text[];
  entry_id    text;
  shape       text;
  clean       jsonb := '[]'::jsonb;
begin
  if new.entries is null then
    return new;
  end if;

  for entry in select jsonb_array_elements(new.entries)
  loop
    entry_id := entry->>'id';
    shape := concat_ws('|',
      coalesce(entry->>'startedAt', 'null'),
      coalesce(entry->>'manicuristId', 'null'),
      coalesce(entry->>'clientName', 'null'),
      coalesce((entry->'services')::text, 'null'),
      coalesce(entry->>'priceCents', 'null'),
      coalesce((entry->>'voided')::boolean, false)::text);

    if entry_id is not null and entry_id = any(seen_ids) then
      continue;
    end if;
    if shape = any(seen_shapes) then
      continue;
    end if;

    clean := clean || jsonb_build_array(entry);
    if entry_id is not null then
      seen_ids := array_append(seen_ids, entry_id);
    end if;
    seen_shapes := array_append(seen_shapes, shape);
  end loop;

  new.entries := clean;
  return new;
end;
$fn$;

drop trigger if exists deduplicate_history_trigger on public.daily_history;
create trigger deduplicate_history_trigger
  before insert or update on public.daily_history
  for each row execute function public.deduplicate_history_entries();

comment on function public.deduplicate_history_entries() is
  'Drops repeated entry ids and fully indistinguishable re-inserts from daily_history.entries. Never collapses rows that differ in price, voided, client or services (KATELYN 09/23: a voided twin sharing startedAt+tech ate the paid row).';
