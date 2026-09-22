@echo off
setlocal
cd /d "%~dp0"
title Yandex Market Digital Goods

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo Starting Yandex Market digital goods service...
"%NODE_EXE%" server.js --open
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo The service could not start. Error code: %EXIT_CODE%
  echo Send a screenshot of this window to support.
) else (
  echo The service has stopped.
)
echo.
echo Press any key to close this window.
pause >nul

