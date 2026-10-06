@echo off
REM TF3 Dashboard - starts the collector (live.lua -> SQLite) and the web server, then opens the browser.
REM With Windows Terminal: ONE window, two panes (collector | server). Without: two classic consoles.
REM Close the window(s) to stop everything. Put the browser full screen (F11) on your second monitor.
REM Optional: config.json next to this file -> { "export_dir": "...", "port": 8765 }
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)

set PORT=8765
for /f "usebackq delims=" %%p in (`%PY% -c "import sys; sys.path.insert(0, 'collector'); import tf3paths; print(tf3paths.port())" 2^>nul`) do set PORT=%%p
set URL=http://127.0.0.1:%PORT%/

REM Optional Windows Terminal profile named "TF3 Dashboard" (icon, colors). Falls back to the default profile.
set WTPROFILE=
set "WTSETTINGS=%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
if exist "%WTSETTINGS%" findstr /c:"\"TF3 Dashboard\"" "%WTSETTINGS%" >nul 2>nul && set WTPROFILE=-p "TF3 Dashboard"

where wt.exe >nul 2>nul
if errorlevel 1 goto :legacy

if defined WT_SESSION goto :inside_wt

REM --- launched from Explorer / shortcut: open a new WT window with both panes
wt -w new %WTPROFILE% --title "TF3 Dashboard Collector" cmd /c "%~dp0_collector.cmd" ; split-pane -V %WTPROFILE% --title "TF3 Dashboard Server" cmd /c "%~dp0_server.cmd" --port %PORT%
timeout /t 3 >nul
start "" "%URL%"
exit /b 0

:inside_wt
REM --- launched from a WT tab: split this tab, run the server in the new pane, the collector here
wt -w 0 split-pane -V %WTPROFILE% --title "TF3 Dashboard Server" cmd /c "%~dp0_server.cmd" --port %PORT%
timeout /t 3 >nul
start "" "%URL%"
title TF3 Dashboard Collector
call "%~dp0_collector.cmd"
exit /b 0

:legacy
REM --- Windows Terminal not installed: two classic console windows
start "TF3 Dashboard Collector" cmd /c "%~dp0_collector.cmd"
start "TF3 Dashboard Server" cmd /c "%~dp0_server.cmd" --port %PORT%
timeout /t 3 >nul
start "" "%URL%"
