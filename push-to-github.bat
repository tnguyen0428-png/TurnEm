@echo off
cd /d "%~dp0"
echo.
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
echo.
echo === Staging changes ===
git add src/components/modals/assignHelpers.tsx src/components/modals/SingleServiceAssign.tsx src/components/modals/MultiServiceAssign.tsx src/components/queue/ManicuristCard.tsx src/state/AppContext.tsx src/lib/tickets.ts
echo.
echo === Committing ===
git commit -m "tickets: yellow APPT IN pill at 30m + restyled busy card + getVisitId-normalized visit lookup to prevent duplicate tickets per customer"
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo === Latest commits ===
git log --oneline -5
echo.
echo Done. Vercel will redeploy in 1-2 minutes. Press any key to close.
pause >nul
