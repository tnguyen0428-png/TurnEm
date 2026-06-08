@echo off
cd /d "%~dp0"
echo === Repairing git index (safe: keeps your file changes) ===
if exist ".git\index.lock" del /q ".git\index.lock"
if exist ".git\index" del /q ".git\index"
git reset -q
echo.
echo === Staging the two fixed files ===
git add src/state/AppContext.tsx src/components/appointments/AppointmentBookView.tsx
echo.
echo === Committing ===
git commit -m "urgent: unlock all appt-book blocks + stop queue sync reverting manual moves"
echo.
echo === Pushing (Vercel auto-deploys in ~1-2 min) ===
git push origin main
echo.
echo Done. Wait for Vercel, then HARD-REFRESH the app (close and reopen / Ctrl-Shift-R).
pause
