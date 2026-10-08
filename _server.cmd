@echo off
REM Pane helper: runs the dashboard web server, restarted by launch.py when it stops. Used by run_dashboard.cmd /
REM run_dashboard_demo.cmd. launch.py extracts the game's icons at first start, waits while the port is taken by an
REM old instance, and opens the browser once the server answers.
REM Usage: _server.cmd [--port N] [--db PATH] [--no-cmd] [--no-browser]
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)
title TF3 Dashboard Server
%PY% launch.py --only server %*
if errorlevel 1 pause
