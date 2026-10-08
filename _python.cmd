@echo off
REM Shared helper: sets PY to the Python interpreter to use. "call _python.cmd" from the other scripts.
REM Order: bundled python_embedded\python.exe (release zip, no installation needed) > py -3 launcher > python on PATH.
REM Nothing is installed; stdlib only is required (Python 3.10+).
set "PY="
if exist "%~dp0python_embedded\python.exe" (
    REM quoted: the install folder may contain spaces ("C:\Users\John Doe\TF3-Dashboard")
    set "PY="%~dp0python_embedded\python.exe""
    goto :found
)
where py.exe >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "PY=py -3"
        goto :found
    )
)
where python.exe >nul 2>nul
if not errorlevel 1 (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "PY=python"
        goto :found
    )
)
echo.
echo [TF3 Dashboard] Python 3.10+ was not found.
echo   Either download the release zip (it includes python_embedded\) or install Python from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH"). Nothing else is needed: no pip, no venv, no packages.
echo.
exit /b 1

:found
set PYTHONIOENCODING=utf-8
set PYTHONDONTWRITEBYTECODE=1
exit /b 0
