@echo off
REM Launches Transport Fever 3 (Steam) WITHOUT the splash logos, optionally with the dashboard.
REM The game has no command-line switch for this, but it reads the hidden setting "showSplashScreen"
REM from <userdata>\settings.lua at startup (and rewrites the file each launch), so the file is
REM patched right before starting the game. The userdata folder is auto-detected (same as the dashboard).
REM Usage: launch_tf3.cmd [dashboard]
setlocal
cd /d "%~dp0"
set APPID=3493540

tasklist /FI "IMAGENAME eq TransportFever3.exe" 2>nul | find /I "TransportFever3.exe" >nul
if not errorlevel 1 (
    echo Transport Fever 3 is already running.
    goto :dash
)

call "%~dp0_python.cmd" >nul 2>nul
if defined PY (
    %PY% -c "import sys, pathlib; sys.path.insert(0, 'collector'); import tf3paths; d = tf3paths.export_dir(); p = d.parent / 'settings.lua' if d else None; s = p.read_text(encoding='utf-8') if p and p.exists() else None; n = s.replace('showSplashScreen = true', 'showSplashScreen = false').replace('splashMusicEnabled = true', 'splashMusicEnabled = false') if s else None; (p.write_text(n, encoding='utf-8'), print('settings.lua: splash disabled')) if n and n != s else print('settings.lua: already patched' if s else 'settings.lua not found (userdata folder unknown): starting normally')"
) else (
    echo Python not found: starting the game normally.
)

start "" "steam://rungameid/%APPID%"

:dash
if /I "%~1"=="dashboard" start "" "%~dp0run_dashboard.cmd"
endlocal
