-- ─────────────────────────────────────────────────────────────────────────────
-- total_turns becomes a DERIVED value with ONE writer (the database).
--
-- WHY (Molani x BRIAN, 2026-08-27):
-- `total_turns` had one writer PER DEVICE. Every client recomputed it from its
-- own local `completed` + `queue` cache (recomputeTotalTurns, reducer.ts) and
-- pushed the ABSOLUTE result on every sync (manicuristToRow, AppContext.tsx).
-- That is only correct if the pushing device's cache is complete.
--
-- 14:41 a credit reconcile correctly repointed Molani's Gel Pedicure from KELLY
--       to BRIAN and moved the turns with compare-and-swap: KELLY 5.5 -> 4.0,
--       BRIAN 5.0 -> 6.5.
-- 14:44 a phone that had been open since 10:57 pressed DONE on the next visit.
--       Safari had suspended the tab and it missed the realtime frame carrying
--       that repoint, so it recomputed BRIAN from a cache that never had the
--       row, got 5.0, and pushed it. The correction was gone three minutes
--       after it was made.
-- 15:06 voiding the duplicate ticket then subtracted the same 1.5 AGAIN, from a
--       total that no longer contained it. BRIAN finished on 3.5 for a $55
--       service the salon collected on.
--
-- Compare-and-swap on the push would NOT have helped: 5.0 was a faithful
-- computation over an incomplete cache, so it would have won the CAS and still
-- been wrong. The defect is the number of writers, not the locking.
--
-- WHY THIS IS NOT THE 2026-05-28 REVERT (commit 48b38c1):
-- A trigger `sync_manicurist_total_turns_from_completed` used to do this and
-- was dropped, because it read ONLY completed_services. The database therefore
-- could not see IN-FLIGHT work (assigned, still in the chair), so an assignment
-- recomputed to 0 and the realtime echo wiped the at-assignment credit off the
-- card. That gap is exactly what the second term below closes: this formula
-- counts in-progress queue entries too, so it is the SAME formula the client
-- already runs. Client and DB now agree instead of fighting, and the client
-- keeps computing locally for instant UI - it just stops WRITING.
--
-- PAIRED CLIENT CHANGE - THIS MIGRATION MUST SHIP WITH IT:
-- `total_turns` is removed from the manicurist sync payload. Applying this
-- migration alone leaves both writers active and the clobber still possible.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The ONE formula ─────────────────────────────────────────────────────────
-- Mirrors recomputeTotalTurns() in src/state/reducer.ts line-for-line:
--
--   totalTurns = SUM(c.turn_value for non-voided completed rows of this staff)
--              + SUM(q.turn_value for this staff's inProgress queue entries
--                    whose id is NOT any completed row's id)
--
-- The dedup term matters and is subtle. Checkout writes the completed row and
-- deletes the queue entry as two separate statements, so for a moment both
-- exist and the visit would be counted twice. The completed row wins.
--
-- CRITICAL: the dedup set is EVERY completed id, including VOIDED ones. That
-- mirrors reducer.ts, where completedIds.add(c.id) runs BEFORE the `if
-- (c.voided) continue` skip. A voided row must still suppress its own queue
-- entry's credit, or voiding a row mid-visit silently re-credits it from the
-- queue side.
create or replace function public.turn_total_for(p_manicurist_id text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    coalesce((
      select sum(cs.turn_value)
      from completed_services cs
      where cs.manicurist_id = p_manicurist_id
        and coalesce(cs.voided, false) = false
    ), 0)
    +
    coalesce((
      select sum(q.turn_value)
      from queue_entries q
      where q.assigned_manicurist_id = p_manicurist_id
        and q.status = 'inProgress'
        and not exists (select 1 from completed_services c where c.id = q.id)
    ), 0);
$function$;

comment on function public.turn_total_for(text) is
  'The single definition of a manicurist''s turn total: non-voided completed work plus in-progress queue entries not already completed. Mirrors recomputeTotalTurns() in src/state/reducer.ts - if you change one, change both.';

-- ── Apply it to a set of staff ──────────────────────────────────────────────
-- Writes only when the value actually differs, so a no-op change does not emit
-- a pointless realtime UPDATE to every device on the floor.
create or replace function public.recompute_total_turns(p_ids text[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  update manicurists m
     set total_turns = public.turn_total_for(m.id)
   where m.id = any(p_ids)
     and m.total_turns is distinct from public.turn_total_for(m.id);
end;
$function$;

-- ── Triggers: recompute whenever either input table changes ─────────────────
-- Both OLD and NEW staff are recomputed so a repoint moves the credit in one
-- step (the old owner loses it, the new owner gains it) with no window where
-- both or neither hold it.
create or replace function public.trg_recompute_turns_from_completed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.recompute_total_turns(array_remove(array[
    case when tg_op in ('UPDATE','DELETE') then old.manicurist_id end,
    case when tg_op in ('UPDATE','INSERT') then new.manicurist_id end
  ], null));
  return null;
end;
$function$;

create or replace function public.trg_recompute_turns_from_queue()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.recompute_total_turns(array_remove(array[
    case when tg_op in ('UPDATE','DELETE') then old.assigned_manicurist_id end,
    case when tg_op in ('UPDATE','INSERT') then new.assigned_manicurist_id end
  ], null));
  return null;
end;
$function$;

drop trigger if exists recompute_turns_from_completed on public.completed_services;
create trigger recompute_turns_from_completed
  after insert or delete or update of manicurist_id, turn_value, voided
  on public.completed_services
  for each row execute function public.trg_recompute_turns_from_completed();

-- queue_entries fires on the columns that can change a credit: who is serving,
-- how much the visit is worth, and whether it is in the chair yet.
drop trigger if exists recompute_turns_from_queue on public.queue_entries;
create trigger recompute_turns_from_queue
  after insert or delete or update of assigned_manicurist_id, turn_value, status
  on public.queue_entries
  for each row execute function public.trg_recompute_turns_from_queue();

-- ── Drift detector for the 23:30 chain ──────────────────────────────────────
-- With one writer this should always be empty. It is a regression alarm, not a
-- repair: turn values feed queue ORDER, so nothing here auto-corrects. Run
-- against the live board BEFORE the archive/reset clears it, same placement as
-- lost_request_check.
create or replace function public.detect_total_turns_drift()
returns table (manicurist_id text, manicurist_name text, stored numeric, expected numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.id, m.name, m.total_turns, public.turn_total_for(m.id)
  from manicurists m
  where coalesce(m.clocked_in, false)
    and m.total_turns is distinct from public.turn_total_for(m.id)
  order by m.name;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- recompute_total_turns is called from the client as an RPC by syncTurnTotal()
-- (src/lib/tickets.ts) after any write that changes a credit. That call is
-- belt-and-braces — the row triggers above already recompute in the same
-- transaction — but it keeps an explicit, greppable marker at each site and
-- covers any future path that writes with triggers disabled. It is idempotent,
-- so calling it twice is free.
grant execute on function public.turn_total_for(text) to anon, authenticated;
grant execute on function public.recompute_total_turns(text[]) to anon, authenticated;
grant execute on function public.detect_total_turns_drift() to anon, authenticated;

-- ── One-time backfill ───────────────────────────────────────────────────────
-- Brings every row to the derived value at deploy time. Verified 2026-08-27:
-- this is a no-op against current data (zero drift across all clocked-in staff)
-- once Molani's row was un-voided, so it should change nothing on a healthy
-- board.
select public.recompute_total_turns(array(select id from manicurists));
