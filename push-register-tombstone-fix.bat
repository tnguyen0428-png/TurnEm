@echo off
cd /d "%~dp0"
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
echo.
echo === Latest local commits ===
git log --oneline -3
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo Done. Vercel will redeploy in 1-2 minutes.
pause
