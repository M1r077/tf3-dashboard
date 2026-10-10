@echo off
REM Builds the release zip: TF3-Dashboard-<version>.zip (companion program + bundled Python, no installation needed)
REM and tf3_dashboard_export-rev<N>.zip (the mod, for manual installation outside mod.io).
REM Usage: build_release.cmd           (the version is VERSION = "x.y.z" in dashboard\server.py; bump it there first)
setlocal
cd /d "%~dp0"
for /f "tokens=2 delims==" %%v in ('findstr /b /c:"VERSION = " dashboard\server.py') do set VERSION=%%v
for /f "tokens=1 delims=# " %%v in ("%VERSION%") do set VERSION=%%v
set VERSION=%VERSION:"=%
if "%VERSION%"=="" (echo could not read VERSION from dashboard\server.py & exit /b 1)
echo [build] version %VERSION%
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
REM icons\ is excluded (extracted from the player's game at first start) except our own drawn icons, which ship
xcopy /q /y /i /s "dashboard\static\icons\own\*" "%STAGE%\dashboard\static\icons\own\" >nul
xcopy /q /y /i /s "docs\*" "%STAGE%\docs\" >nul
mkdir "%STAGE%\music" >nul 2>nul
copy /y "music\README.txt" "%STAGE%\music\" >nul
REM test\ (demo data generator, run_dashboard_demo.cmd) is a developer tool and stays out of the release zip
for %%f in (run_dashboard.cmd _collector.cmd _server.cmd _python.cmd README.md LICENSE config.example.json) do copy /y "%%f" "%STAGE%\" >nul
mkdir "%STAGE%\db"
echo %VERSION%> "%STAGE%\VERSION"

REM cmd.exe needs CRLF line endings, otherwise "goto :label" fails with "The system cannot find the batch label specified".
REM Normalize whatever the working copy has (git may have checked them out as LF).
powershell -NoProfile -Command "Get-ChildItem -Path '%STAGE%' -Recurse -Filter *.cmd | ForEach-Object { $t = [IO.File]::ReadAllText($_.FullName) -replace \"`r?`n\", \"`r`n\"; [IO.File]::WriteAllText($_.FullName, $t, (New-Object Text.UTF8Encoding $false)) }" || exit /b 1

echo [build] mod
mkdir "%STAGE%\mod" 2>nul
xcopy /q /y /i /s "mod\tf3_dashboard_export" "%STAGE%\mod\tf3_dashboard_export\" >nul
REM the mod.io entry id is private to the author (the Mod Hub would try to *update* that entry instead of creating a new one)
del "%STAGE%\mod\tf3_dashboard_export\_metadata\mod.io_fileid.txt" 2>nul

echo [build] zip
if exist "%DIST%" del "%DIST%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%' -DestinationPath '%DIST%' -CompressionLevel Optimal" || exit /b 1
for /f %%r in ('powershell -NoProfile -Command "(Get-Content 'mod\tf3_dashboard_export\mod.json' | ConvertFrom-Json).revision"') do set REV=%%r
set MODZIP=%OUT%\tf3_dashboard_export-rev%REV%.zip
if exist "%MODZIP%" del "%MODZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\mod\tf3_dashboard_export' -DestinationPath '%MODZIP%' -CompressionLevel Optimal" || exit /b 1
rmdir /s /q "%STAGE%"
echo.
echo [build] done:
dir /b "%OUT%\*.zip"
endlocal

