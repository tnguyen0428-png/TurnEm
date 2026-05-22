@echo off
cd /d "%~dp0"
echo.
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
echo.
echo === Staging changes ===
git add src/components/register/TicketModal.tsx
echo.
echo === Committing ===
git commit -m "register: flip manicurist BUSY on added line + sync in-progress queue services/turns when ticket line service changes"
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo === Latest commits ===
git log --oneline -5
echo.
echo Done. Vercel will redeploy in 1-2 minutes. Press any key to close.
pause ^>nul
