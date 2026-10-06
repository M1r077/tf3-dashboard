@echo off
REM Starts the collector alone (watches live.lua, fills the SQLite db). Ctrl+C to stop.
REM Extra arguments are passed through, e.g. run_collector.cmd --status / --once / --list-games
cd /d "%~dp0.."
call "%~dp0..\_python.cmd" || (pause & exit /b 1)
%PY% collector\collector.py %*
pause
