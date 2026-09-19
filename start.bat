@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist "web\node_modules" goto setup
if not exist "worker\node_modules" goto setup
if not exist "chain\node_modules" goto setup
goto run
:setup
call npm run setup
if errorlevel 1 (
  echo Setup failed. Check your internet connection and the message above.
  pause
  exit /b 1
)
:run
echo Open http://localhost:5173 after both servers are ready.
echo Keep this window open while using Safety Guard. Press Ctrl+C to stop.
call npm run dev
pause
