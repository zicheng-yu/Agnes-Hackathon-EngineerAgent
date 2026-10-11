@echo off
setlocal
rem Keep this CMD bootstrap ASCII-only; Node prints the UTF-8 diagnostics.
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
echo.
echo Starting EngineerAgent...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24.10 or later with npm: https://nodejs.org/
  echo Reopen this launcher after installation.
  pause
  exit /b 1
)
node scripts/start-local.mjs --install --open
if errorlevel 1 (
  echo.
  echo Startup failed. Keep the diagnostics above; see README.md.
  pause
  exit /b 1
)
endlocal
