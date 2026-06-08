@echo off
REM Commit + push tonight's TurnEm fixes.
REM Includes:
REM   1. src/lib/tickets.ts  — preserve queue_entry_id in mergeOpenTicketsByClient
REM      (stops the phantom NULL-qid lines on merged tickets, e.g. ticket #29 today)
REM   2. supabase/migrations/20260529180000_skip_ticket_items_duplicate_null_qid.sql
REM      (already applied to prod via MCP; source-control copy for parity)
REM   3. src/state/reducer.ts — wrap appReducer with convergeTotalTurns so
REM      manicurists.totalTurns is always derived from state.completed +
REM      state.queue. Eliminates the closure-state drift in TicketModal.doSave
REM      and the missing recompute on REMOTE_COMPLETED_UPSERT.
REM      (Macy 2.5/2.0 and 8.5/7.5 drifts both came from these two seams.)

cd /d %~dp0

REM Reset accidental _trash staging from earlier session
git reset HEAD _trash 2>nul

git add src/lib/tickets.ts ^
        src/state/reducer.ts ^
        supabase/migrations/20260529180000_skip_ticket_items_duplicate_null_qid.sql

git commit -m "fix(tickets+turns): stop phantom lines on merge + auto-converge totalTurns" ^
           -m "1) mergeOpenTicketsByClient (lib/tickets.ts) dropped queue_entry_id" ^
           -m "   when forwarding secondary items to appendItemsToTicket, so" ^
           -m "   dedupe via seenEntryIds and the partial unique index" ^
           -m "   uniq_ticket_items_per_entry both no-op'd. Every RegisterScreen" ^
           -m "   reconcile cycle (fires on each state.completed change) then" ^
           -m "   duplicated the same service lines on the primary as fresh" ^
           -m "   NULL-qid rows. Ticket #29 (Rebecca, 2026-05-29) collected 17+" ^
           -m "   phantom Gel Pedicures inside 5 minutes. Fix: forward the qid." ^
           -m "" ^
           -m "2) appReducer now wraps the per-action case in convergeTotalTurns," ^
           -m "   which derives each manicurist's totalTurns from state.completed" ^
           -m "   + state.queue (non-voided completed credit + in-progress queue" ^
           -m "   credit, deduped by id to handle the brief REMOTE_COMPLETED_UPSERT" ^
           -m "   -> REMOTE_QUEUE_DELETE race). This closes two silent drift" ^
           -m "   seams: the closure-captured 'localCur' in TicketModal.doSave" ^
           -m "   (which overwrote newer values with stale snapshots) and the" ^
           -m "   missing totalTurns recompute on REMOTE_COMPLETED_UPSERT (which" ^
           -m "   left cross-tab edits invisible to the card). Macy's two manual" ^
           -m "   fixes today (2.5 -> 2.0 AM, 8.5 -> 7.5 PM) were both this." ^
           -m "" ^
           -m "Also adds defense-in-depth: BEFORE INSERT trigger" ^
           -m "ticket_items_skip_duplicate_null_qid silently drops any future" ^
           -m "identical NULL-qid service row (same ticket/name/staff/price)."

git push origin main

echo.
echo Done. Vercel will auto-deploy in 1-2 min.
pause
