# ============================================================================
# TurnEm — deploy the completed-history data-loss fix
#   - Verifies typecheck + build BEFORE committing (aborts if either fails)
#   - Commits the client guard + nightly edge merge + delete-safety-net migration
#   - Pushes to main, which triggers the Vercel auto-deploy
#
# The edge function and the migration are ALREADY live on Supabase (applied via
# MCP). This commit just gets the repo in sync and ships the CLIENT fix — the
# permanent source fix that stops the bad auto-delete from ever firing.
#
# After this runs and Vercel finishes: HARD-REFRESH every POS device
# (unregister service worker / Ctrl+Shift+R) so they all run the new client.
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\ethan\TurnEmApp'

Write-Host "`n=== 1/5  Latest from origin ===" -ForegroundColor Cyan
git fetch origin
git status

Write-Host "`n=== 2/5  Typecheck ===" -ForegroundColor Cyan
npm run typecheck
if ($LASTEXITCODE -ne 0) { Write-Host "Typecheck FAILED — aborting, nothing committed." -ForegroundColor Red; exit 1 }

Write-Host "`n=== 3/5  Production build ===" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build FAILED — aborting, nothing committed." -ForegroundColor Red; exit 1 }

Write-Host "`n=== 4/5  Stage + commit ===" -ForegroundColor Cyan
git add `
  src/state/AppContext.tsx `
  supabase/functions/nightly-save-history/index.ts `
  supabase/migrations/20260606000000_completed_services_delete_safety_net.sql

# Show exactly what will be committed
git status --short
git commit -m "fix(history): stop silent loss of completed turns

- syncCompleted no longer deletes a completed_services row just because it
  vanished from in-memory state; deletes only on explicit user action
  (DELETE_COMPLETED) or an authorized bulk clear (CLEAR_HISTORY / post-save
  DAILY_RESET). A row that drops out during a sync race self-heals on reload.
  Root cause of the 6/5 missing-morning-turns incident.
- saveTodayHistory + nightly-save-history now MERGE the day's history by entry
  id instead of overwriting, so a partial/stale save can't erase a fuller one.
- add completed_services delete safety-net trigger (recovery log).

Edge fn + migration already applied live via MCP; this syncs the repo."

Write-Host "`n=== 5/5  Push (triggers Vercel deploy) ===" -ForegroundColor Cyan
git push origin HEAD

Write-Host "`nDONE. Watch Vercel finish, then HARD-REFRESH every POS device." -ForegroundColor Green
