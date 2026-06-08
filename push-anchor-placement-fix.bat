@echo off
cd /d "%~dp0"
echo === Typecheck (must show no errors before deploying) ===
call npm run typecheck
if errorlevel 1 (
  echo.
  echo TYPECHECK FAILED - not committing. Fix errors above and re-run.
  pause
  exit /b 1
)
echo.
echo === Removing stale git lock if present ===
if exist ".git\index.lock" del /f ".git\index.lock"
echo.
echo === Staging the fixed file ===
git add src/components/modals/AppointmentModal.tsx
echo.
echo === Committing ===
git commit -m "fix(appt-book): keep same-time anchor manicurist placed on edit/shorten so slot doesn't vanish"
echo.
echo === Pushing (Vercel auto-deploys in ~1-2 min) ===
git push origin main
echo.
echo Done. Wait for Vercel, then HARD-REFRESH the app (Ctrl-Shift-R).
pause
