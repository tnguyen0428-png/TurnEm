@echo off
cd /d "%~dp0"
echo.
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
if exist ".git\refs\heads\main.lock" del /q ".git\refs\heads\main.lock"
if exist ".git\index" del /q ".git\index"
echo.
echo === Rebuilding git index ===
git read-tree HEAD
echo.
echo === Staging changes ===
git add src/state/AppContext.tsx src/lib/tickets.ts src/lib/giftCertificates.ts
echo.
echo === Committing ===
git commit -m "fix: restore truncated AppContext.tsx tail (lost in bundle commit); paginate gift cert reads"
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo === Latest commits ===
git log --oneline -5
echo.
echo Done. Vercel will redeploy in 1-2 minutes. Press any key to close.
pause ^>nul
