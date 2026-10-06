@echo off
REM Demo without the game: regenerates simulated data and serves the dashboard on port 8766.
cd /d "%~dp0"
call "%~dp0_python.cmd" || (pause & exit /b 1)
set PORT=8766
set URL=http://127.0.0.1:%PORT%/

%PY% test\make_fake_data.py || (pause & exit /b 1)

set WTPROFILE=
set "WTSETTINGS=%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
if exist "%WTSETTINGS%" findstr /c:"\"TF3 Dashboard\"" "%WTSETTINGS%" >nul 2>nul && set WTPROFILE=-p "TF3 Dashboard"

where wt.exe >nul 2>nul
if errorlevel 1 goto :legacy

if defined WT_SESSION (
    wt -w 0 new-tab %WTPROFILE% --title "TF3 Dashboard Demo" cmd /c "%~dp0_server.cmd" --db test\fake.db --port %PORT% --no-cmd
) else (
    wt -w new %WTPROFILE% --title "TF3 Dashboard Demo" cmd /c "%~dp0_server.cmd" --db test\fake.db --port %PORT% --no-cmd
)
timeout /t 3 >nul
start "" "%URL%"
exit /b 0

:legacy
start "TF3 Server (demo)" cmd /c "%~dp0_server.cmd" --db test\fake.db --port %PORT% --no-cmd
timeout /t 2 >nul
start "" "%URL%"
