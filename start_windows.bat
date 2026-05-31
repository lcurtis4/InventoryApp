@echo off
setlocal

set PORT=8765
set URL=http://localhost:%PORT%/

cd /d "%~dp0"

echo Starting local dev server (no-cache) on %URL% ...
echo.

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "%URL%"
  py -3 server/dev_server.py %PORT%
  goto :eof
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "%URL%"
  python server/dev_server.py %PORT%
  goto :eof
)

where python3 >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "%URL%"
  python3 server/dev_server.py %PORT%
  goto :eof
)

echo ERROR: Python was not found by Windows.
echo.
echo Try this:
echo   1. Close this window.
echo   2. Open Command Prompt.
echo   3. Run: py --version
echo.
echo If py works, tell me. If it does not, reinstall Python from:
echo https://www.python.org/downloads/
echo and check "Add python.exe to PATH" on the installer screen.
echo.
pause
