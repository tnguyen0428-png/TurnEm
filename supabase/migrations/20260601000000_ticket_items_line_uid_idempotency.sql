-- ============================================================================
-- Migration: line_uid idempotency for ticket_items
-- Created: 2026-05-31
--
-- WHAT THIS FIXES
-- ---------------
-- Phantom duplicate ticket lines have recurred for weeks. Every prior fix
-- pattern-matched a queue_entry_id SHAPE (`-add-`, bare visit id, NULL, etc.)
-- and dropped it. New shapes kept slipping through, so another trigger got
-- added each time. There are now SIX triggers on this table.
--
-- Inspecting the schema also revealed THREE separate mechanisms all trying to
-- enforce "no duplicate service line":
--   1. trigger  reject_ticket_items_duplicate_composite_key   (silently drops)
--   2. index    uniq_ticket_items_visit_service               (hard error)
--   3. client filter in updateOpenTicket (tickets.ts)         (silently drops)
-- All three key off (ticket, name, staff, price) or a parsed slice of
-- queue_entry_id.
--
-- The salon has CONFIRMED a client can legitimately receive the SAME service
-- twice -- same price, same technician -- on one ticket. So all three of these
-- are currently DROPPING REAL, BILLABLE LINES, undercharging the customer.
-- This is the mirror image of the phantom bug and started 2026-05-30.
--
-- THE REAL FIX
-- ------------
-- Give every line a stable `line_uid` that the client generates ONCE when the
-- cashier adds it, and threads through every insert path. Then:
--   * Phantom    = the same logical line written twice by different code paths
--                  = SAME line_uid = collapses to one via ON CONFLICT DO NOTHING.
--   * Legit repeat = a genuinely separate add = its OWN line_uid = preserved.
-- Line identity no longer depends on queue_entry_id at all, which is what made
-- the old approach fragile.
--
-- HOW TO APPLY
-- ------------
-- This file has TWO phases. PHASE 1 is additive and safe to run right now; it
-- changes no behavior. PHASE 2 is destructive and is COMMENTED OUT -- run it
-- ONLY after the client build that populates line_uid is live and verified,
-- otherwise there is a window with no phantom protection.
-- ============================================================================


-- ============================================================================
-- PHASE 1  -- additive, safe to apply now. No behavior change.
-- ============================================================================

-- 1a. The new stable line identity. Nullable, so all 5,748 existing rows and
--     any not-yet-upgraded client keep working untouched.
ALTER TABLE public.ticket_items
  ADD COLUMN IF NOT EXISTS line_uid text;

-- 1b. The idempotency guarantee: at most one row per line_uid. NON-partial so
--     supabase-js `.upsert(..., { onConflict: 'line_uid' })` can infer it.
--     Postgres treats NULLs as DISTINCT, so the 5,748 historical rows
--     (line_uid IS NULL) are all still allowed and unaffected. Once the client
--     sends line_uid together with ON CONFLICT (line_uid) DO NOTHING, a
--     duplicate insert of the SAME logical line becomes a silent no-op in the
--     database -- regardless of which code path fires or in what order.
--
--     NOTE: Phase 1 (this column + index) was applied LIVE to the TurnEM Salon
--     project on 2026-05-31. This file is the versioned record so `supabase db
--     push` reproduces the same state on any other environment.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ticket_items_line_uid
  ON public.ticket_items (line_uid);

-- >>> STOP HERE for the first deployment. Everything below is Phase 2. <<<


-- ============================================================================
-- PHASE 2  -- DESTRUCTIVE.  DO NOT RUN until the client that populates
--            line_uid on every insert path is live in production AND a repro
--            test confirms phantoms collapse and real duplicates survive.
--            Running this early re-opens the phantom window.
--
--            To apply: delete the `-- ` in front of each statement below.
-- ============================================================================

-- 2a. Remove the composite-key trigger that silently drops legitimate repeats.
-- DROP TRIGGER IF EXISTS ticket_items_reject_duplicate_composite_key ON public.ticket_items;
-- DROP FUNCTION IF EXISTS public.reject_ticket_items_duplicate_composite_key();

-- 2b. Remove the visit/service unique index -- the OTHER legit-duplicate
--     blocker (it hard-errors a real second identical line). line_uid
--     replaces the identity job this index was doing.
-- DROP INDEX IF EXISTS public.uniq_ticket_items_visit_service;

-- 2c. OPTIONAL cleanup -- retire the queue_entry_id-pattern skip triggers.
--     Safe to leave in place (they only drop the odd qid shapes the upgraded
--     client no longer produces). Drop them only once you are confident the
--     new path is the sole writer.
-- DROP TRIGGER IF EXISTS ticket_items_skip_add_child_qid ON public.ticket_items;
-- DROP TRIGGER IF EXISTS ticket_items_skip_duplicate_null_qid ON public.ticket_items;

-- KEEP (do NOT drop) -- these are correct and behavior-based, not qid-pattern:
--   * ticket_items_reject_on_closed_unconditional  (Guard A: blocks writes to
--                                                    a closed/voided ticket)
--   * ticket_items_guard_voided                    (protects voided tickets)
--   * ticket_items_skip_on_closed                  (harmless extra closed guard)

-- End of PHASE 2.
