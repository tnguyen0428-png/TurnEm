-- ─────────────────────────────────────────────────────────────────────────────
-- Verification harness for 20260827230000_total_turns_single_writer.sql
--
-- HOW TO RUN, in the Supabase SQL editor:
--   1. paste the `begin;` line below
--   2. paste the FULL BODY of 20260827230000_total_turns_single_writer.sql
--      (everything except its own comments — it has no transaction control)
--   3. paste the rest of this file, from "Fixtures" to the final `rollback;`
--   4. run it all as one statement
-- It exercises the migration, prints a PASS/FAIL table, and ROLLS BACK.
-- Nothing persists — verified 2026-08-27: no triggers, functions or test rows
-- survived, and no manicurist's total_turns moved.
--
-- (There is no \i include here on purpose: psql meta-commands do not work in
-- the SQL editor, and this needs to run in ONE transaction to be rollback-safe.)
--
-- Safe to run against PRODUCTION, and that is the point. A Supabase branch
-- replays only supabase/migrations, and this project's folder holds 115 of the
-- 159 migrations production has actually applied (44 were hand-applied and
-- never captured), so a branch builds a DIFFERENT schema and would pass or fail
-- for the wrong reasons. Testing inside a rolled-back transaction on the real
-- database is the only faithful check available.
--
-- Picks its own fixtures from live data, so it stays valid on any day. If the
-- board is empty (no completed work yet, nobody in a chair) some tests report
-- SKIP rather than failing.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- ▼▼▼ PASTE THE BODY OF 20260827230000_total_turns_single_writer.sql HERE ▼▼▼
-- ▲▲▲ ────────────────────────────────────────────────────────────────── ▲▲▲

-- ── Fixtures, chosen from whatever is on the board right now ────────────────
create temp table fx as
select
  cs.id            as cs_id,
  cs.manicurist_id as owner_id,
  cs.turn_value    as tv,
  (select m.id from manicurists m
    where coalesce(m.clocked_in,false) and m.id <> cs.manicurist_id
    order by m.id limit 1) as other_id,
  (select q.id from queue_entries q
    where q.status = 'inProgress'
      and q.assigned_manicurist_id is not null
      and not exists (select 1 from completed_services c where c.id = q.id)
    order by q.arrived_at limit 1) as live_qid
from completed_services cs
where not coalesce(cs.voided,false)
  and cs.turn_value > 0
  and cs.manicurist_id is not null
order by cs.completed_at desc
limit 1;

create temp table pre  as select id, total_turns from manicurists;
select public.recompute_total_turns(array(select id from manicurists));
create temp table base as select id, total_turns from manicurists;
create temp table t(step text, detail text, pass boolean);

-- T1 ── the backfill must be a no-op on a healthy board
insert into t select 'T1 backfill changes nothing',
  format('%s of %s rows moved',
    (select count(*) from pre join base using(id) where pre.total_turns is distinct from base.total_turns),
    (select count(*) from pre)),
  not exists (select 1 from pre join base using(id)
              where pre.total_turns is distinct from base.total_turns);

-- T2 ── the drift detector agrees with the stored value
insert into t select 'T2 drift detector clean', format('%s drift rows', count(*)), count(*) = 0
from public.detect_total_turns_drift();

-- T3 ── a repoint moves the credit in ONE step (the Molani failure mode)
update completed_services set manicurist_id = (select other_id from fx)
 where id = (select cs_id from fx);
insert into t select 'T3 repoint moves credit atomically',
  format('owner %s->%s, other %s->%s (tv %s)', ob.total_turns, o.total_turns, nb.total_turns, n.total_turns, fx.tv),
  o.total_turns = ob.total_turns - fx.tv and n.total_turns = nb.total_turns + fx.tv
from fx
  join manicurists o on o.id = fx.owner_id  join base ob on ob.id = fx.owner_id
  join manicurists n on n.id = fx.other_id  join base nb on nb.id = fx.other_id;

-- T4 ── and repointing back restores both
update completed_services set manicurist_id = (select owner_id from fx)
 where id = (select cs_id from fx);
insert into t select 'T4 repoint back restores both',
  format('owner=%s other=%s', o.total_turns, n.total_turns),
  o.total_turns = ob.total_turns and n.total_turns = nb.total_turns
from fx
  join manicurists o on o.id = fx.owner_id  join base ob on ob.id = fx.owner_id
  join manicurists n on n.id = fx.other_id  join base nb on nb.id = fx.other_id;

-- T5 ── voiding removes the credit with no hand-applied delta anywhere
update completed_services set voided = true where id = (select cs_id from fx);
insert into t select 'T5 void removes credit',
  format('owner %s->%s', ob.total_turns, o.total_turns), o.total_turns = ob.total_turns - fx.tv
from fx join manicurists o on o.id = fx.owner_id join base ob on ob.id = fx.owner_id;

-- T6 ── re-voiding cannot subtract twice. A derived total has no memory, which
--       is what made the old delta path double-refund Molani.
update completed_services set voided = true where id = (select cs_id from fx);
insert into t select 'T6 re-void cannot double-subtract',
  format('owner=%s', o.total_turns), o.total_turns = ob.total_turns - fx.tv
from fx join manicurists o on o.id = fx.owner_id join base ob on ob.id = fx.owner_id;
update completed_services set voided = false where id = (select cs_id from fx);

-- T7 ── in-flight work counts. This is the gap that forced the 2026-05-28
--       revert of the old completed-only trigger; if this fails, the card
--       drops to 0 the moment a client is assigned.
insert into t select 'T7 in-progress work is credited',
  coalesce(format('%s: stored %s, completed-only %s, in chair %s',
    q.assigned_manicurist_id, m.total_turns,
    (select coalesce(sum(turn_value),0) from completed_services
      where manicurist_id = q.assigned_manicurist_id and not coalesce(voided,false)), q.turn_value),
    'SKIP - nobody in a chair'),
  m.total_turns = (select coalesce(sum(turn_value),0) from completed_services
                    where manicurist_id = q.assigned_manicurist_id and not coalesce(voided,false))
                  + q.turn_value
from fx join queue_entries q on q.id = fx.live_qid
        join manicurists m on m.id = q.assigned_manicurist_id;

-- T8 ── the checkout race: for a moment the completed row and the queue entry
--       both exist. The visit must be counted ONCE.
insert into completed_services
  (id, client_name, service, services, turn_value, manicurist_id, manicurist_name,
   manicurist_color, started_at, completed_at, is_appointment, is_requested, voided)
select q.id, q.client_name, 'Gel Pedicure', array['Gel Pedicure'], q.turn_value,
       q.assigned_manicurist_id, m.name, m.color, now(), now(), false, false, false
from fx join queue_entries q on q.id = fx.live_qid
        join manicurists m on m.id = q.assigned_manicurist_id;
insert into t select 'T8 checkout race does not double-count',
  format('%s = %s (want unchanged)', q.assigned_manicurist_id, m.total_turns),
  m.total_turns = b.total_turns
from fx join queue_entries q on q.id = fx.live_qid
        join manicurists m on m.id = q.assigned_manicurist_id
        join base b on b.id = q.assigned_manicurist_id;

select step, detail, case when pass then 'PASS' else '*** FAIL ***' end as result
from t order by step;

rollback;
