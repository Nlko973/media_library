@echo off
setlocal
title Media Library - Start
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

echo.
echo ========================================
echo   Media Library
echo ========================================
echo.

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm was not found.
  echo Please install Node.js, then run Start.bat again.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies. This is needed only on first launch.
  npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting app...
echo.
if exist "node_modules\electron\dist\electron.exe" (
  "node_modules\electron\dist\electron.exe" --disable-gpu --disable-gpu-sandbox --disable-software-rasterizer .
) else (
  npm.cmd run start
)
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo App closed. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
