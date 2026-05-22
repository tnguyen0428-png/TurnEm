@echo off
cd /d "%~dp0"
echo.
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
if exist ".git\refs\heads\main.lock" del /q ".git\refs\heads\main.lock"
echo.
echo === Staging changes ===
git add src/components/shared/ReceptionistPinGate.tsx src/components/register/OpenShiftModal.tsx src/components/register/CloseShiftScreen.tsx src/lib/tickets.ts src/components/register/TicketModal.tsx src/components/history/HistoryScreen.tsx src/state/AppContext.tsx
echo.
echo === Committing ===
git commit -m "bundle: append/sync insert ON CONFLICT, ticket-add turn credit, history chrono sort, PIN auto-focus, archive flow hardening (no data loss on partial archive)"
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo === Latest commits ===
git log --oneline -8
echo.
echo Done. Vercel will redeploy in 1-2 minutes. Press any key to close.
pause ^>nul
