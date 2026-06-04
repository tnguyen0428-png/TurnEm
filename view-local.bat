@echo off
REM Start the TurnEm dev server for a local preview (no deploy).
REM Double-click this, then open the URL it prints (usually http://localhost:5173).
cd /d "%~dp0"
echo Starting local dev server...  Press Ctrl+C in this window to stop.
call npm run dev
pause
