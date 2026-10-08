@echo off
REM Pane helper: runs the dashboard web server. Used by run_dashboard.cmd / run_dashboard_demo.cmd.
REM Usage: _server.cmd [--port N] [--db PATH] [--no-cmd]
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)
set ARGS=%*
title TF3 Dashboard Server

REM find --port value (default 8765)
set PORT=8765
:parse
if "%~1"=="" goto :icons
if /i "%~1"=="--port" set PORT=%~2
shift
goto :parse

:icons
REM first start: extract the game's icons (cargo, vehicles, UI) from the local game installation
if not exist "dashboard\static\icons\_manifest.json" (
    echo first start: extracting the game's icons, a few seconds...
    %PY% dashboard\extract_icons.py
    echo.
)

:run
REM refuse to start a second server on the same port: an old instance would silently keep serving old code
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo port %PORT% already in use:
    netstat -ano | findstr /r /c:":%PORT% .*LISTENING"
    echo close the other TF3 Dashboard window first, then press a key to retry.
    pause >nul
    goto :run
)
%PY% dashboard\server.py %ARGS%
echo.
echo server stopped (exit code %ERRORLEVEL%). Close this pane or press a key to retry.
pause >nul
goto :run
