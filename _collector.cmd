@echo off
REM Pane helper: runs the collector (live.lua -> SQLite), restarted by launch.py when it stops. Used by run_dashboard.cmd.
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)
title TF3 Dashboard Collector
%PY% launch.py --only collector %*
if errorlevel 1 pause
