@echo off
REM Pane helper: runs the collector (live.lua -> SQLite). Used by run_dashboard.cmd.
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)
title TF3 Dashboard Collector
:run
%PY% collector\collector.py %*
echo.
echo collector stopped (exit code %ERRORLEVEL%). Close this pane or press a key to retry.
pause >nul
goto :run
