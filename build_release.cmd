@echo off
REM Builds the release zip: TF3-Dashboard-<version>.zip (companion program + bundled Python, no installation needed)
REM and tf3_dashboard_export-rev<N>.zip (the mod, for manual installation outside mod.io).
REM Usage: build_release.cmd 0.1.0
setlocal
cd /d "%~dp0"
set VERSION=%~1
if "%VERSION%"=="" (echo usage: build_release.cmd ^<version^>  e.g. 0.1.0 & exit /b 1)
set PYVER=3.12.10
set PYZIP=python-%PYVER%-embed-amd64.zip
set PYURL=https://www.python.org/ftp/python/%PYVER%/%PYZIP%
set OUT=release
set STAGE=%OUT%\TF3-Dashboard
set DIST=%OUT%\TF3-Dashboard-%VERSION%.zip

if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
mkdir "%OUT%\cache" 2>nul

echo [build] Python embeddable %PYVER%
if not exist "%OUT%\cache\%PYZIP%" (
    powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '%PYURL%' -OutFile '%OUT%\cache\%PYZIP%'" || exit /b 1
)
powershell -NoProfile -Command "Expand-Archive -Force '%OUT%\cache\%PYZIP%' '%STAGE%\python_embedded'" || exit /b 1
REM the embeddable build ships python312.zip (stdlib) + python312._pth; nothing else is needed (stdlib only, no pip)

echo [build] companion files
xcopy /q /y /i "collector\*.py" "%STAGE%\collector\" >nul
xcopy /q /y /i "collector\schema.sql" "%STAGE%\collector\" >nul
xcopy /q /y /i "collector\run_collector.cmd" "%STAGE%\collector\" >nul
xcopy /q /y /i "dashboard\*.py" "%STAGE%\dashboard\" >nul
xcopy /q /y /i /s "dashboard\static\*" "%STAGE%\dashboard\static\" /exclude:build_exclude.txt >nul
xcopy /q /y /i "test\make_fake_data.py" "%STAGE%\test\" >nul
xcopy /q /y /i /s "docs\*" "%STAGE%\docs\" >nul
for %%f in (run_dashboard.cmd run_dashboard_demo.cmd _collector.cmd _server.cmd _python.cmd README.md LICENSE config.example.json) do copy /y "%%f" "%STAGE%\" >nul
mkdir "%STAGE%\db"
echo %VERSION%> "%STAGE%\VERSION"

echo [build] mod
mkdir "%STAGE%\mod" 2>nul
xcopy /q /y /i /s "mod\tf3_dashboard_export" "%STAGE%\mod\tf3_dashboard_export\" >nul

echo [build] zip
if exist "%DIST%" del "%DIST%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%' -DestinationPath '%DIST%' -CompressionLevel Optimal" || exit /b 1
for /f %%r in ('powershell -NoProfile -Command "(Get-Content 'mod\tf3_dashboard_export\mod.json' | ConvertFrom-Json).revision"') do set REV=%%r
set MODZIP=%OUT%\tf3_dashboard_export-rev%REV%.zip
if exist "%MODZIP%" del "%MODZIP%"
powershell -NoProfile -Command "Compress-Archive -Path 'mod\tf3_dashboard_export' -DestinationPath '%MODZIP%' -CompressionLevel Optimal" || exit /b 1
rmdir /s /q "%STAGE%"
echo.
echo [build] done:
dir /b "%OUT%\*.zip"
endlocal
