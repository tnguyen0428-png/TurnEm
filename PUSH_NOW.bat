@echo off
cd /d "C:\Users\ethan\TurnEmApp"
echo ============================================
echo  TurnEm - Pushing all changes to GitHub
echo ============================================
echo.

REM Clear any stale git locks
if exist ".git\index.lock" del /f ".git\index.lock"

REM Stage all source changes
git add src\ supabase\migrations\ public\ PENDING_DEPLOY.md

REM Commit (handles merge state too)
git commit -m "feat: appointment book, blueprint, staff roles, REQ badge, skill validation"

REM Push to GitHub (Vercel auto-deploys)
git push origin main

echo.
echo ============================================
echo  Done! Vercel deploys in ~1-2 minutes.
echo  Check: https://turnem.io
echo ============================================
pause
