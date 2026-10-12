@echo off
REM TF3 Dashboard - starts the collector (live.lua -> SQLite) and the web server, then opens the browser.
REM With Windows Terminal: ONE window, two panes (collector | server). Without: one console, both outputs prefixed.
REM Close the window to stop everything. Put the browser full screen (F11) on your second monitor.
REM Optional: config.json next to this file -> { "export_dir": "...", "port": 8765 }
REM The logic (icons, port check, restarts, browser) is in launch.py, shared with run_dashboard.sh on Linux.
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)

REM Optional Windows Terminal profile named "TF3 Dashboard" (icon, colors). Falls back to the default profile.
set WTPROFILE=
set "WTSETTINGS=%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
if exist "%WTSETTINGS%" findstr /c:"\"TF3 Dashboard\"" "%WTSETTINGS%" >nul 2>nul && set WTPROFILE=-p "TF3 Dashboard"

where wt.exe >nul 2>nul
if errorlevel 1 goto :legacy

if defined WT_SESSION goto :inside_wt

REM --- launched from Explorer / shortcut: open a new WT window with both panes
wt -w new %WTPROFILE% --title "TF3 Dashboard Collector" cmd /c "%~dp0_collector.cmd" %* ; split-pane -V %WTPROFILE% --title "TF3 Dashboard Server" cmd /c "%~dp0_server.cmd" %*
exit /b 0

:inside_wt
REM --- launched from a WT tab: split this tab, run the server in the new pane, the collector here
wt -w 0 split-pane -V %WTPROFILE% --title "TF3 Dashboard Server" cmd /c "%~dp0_server.cmd" %*
call "%~dp0_collector.cmd" %*
exit /b 0

:legacy
REM --- Windows Terminal not installed: both in this console, lines prefixed [collector] / [server]
title TF3 Dashboard
%PY% launch.py %*
if errorlevel 1 pause
