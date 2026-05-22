@echo off
cd /d "%~dp0"
echo.
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
if exist ".git\refs\heads\main.lock" del /q ".git\refs\heads\main.lock"
echo.
echo === Staging changes ===
git add src/lib/tickets.ts
echo.
echo === Committing ===
git commit -m "tickets: paginate fetchTicketsForDate/Range/Shift items+payments reads (1929-item migration ticket starved the 1000-row cap, leaving SERVICES blank in Register)"
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo === Latest commits ===
git log --oneline -5
echo.
echo Done. Vercel will redeploy in 1-2 minutes. Press any key to close.
pause ^>nul
