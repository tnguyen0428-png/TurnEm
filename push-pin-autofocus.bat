@echo off
cd /d "%~dp0"
echo.
echo === Clearing any stale git locks ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\HEAD.lock" del /q ".git\HEAD.lock"
if exist ".git\refs\heads\main.lock" del /q ".git\refs\heads\main.lock"
echo.
echo === Staging changes ===
git add src/components/shared/ReceptionistPinGate.tsx src/components/register/OpenShiftModal.tsx src/components/register/CloseShiftScreen.tsx src/components/staff/StaffLoginScreen.tsx
echo.
echo === Committing ===
git commit -m "pin gates: auto-focus PIN input so user can type immediately (no need to click box first)"
echo.
echo === Pushing to GitHub ===
git push origin main
echo.
echo === Latest commits ===
git log --oneline -5
echo.
echo Done. Vercel will redeploy in 1-2 minutes. Press any key to close.
pause ^>nul
