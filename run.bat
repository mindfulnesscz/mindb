@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: Package Collector — Windows launcher
:: Double-click this file to run the app.
:: On first run it creates a local .venv and installs dependencies.
:: ─────────────────────────────────────────────────────────────────────────────

cd /d "%~dp0"

set VENV=.venv
set PYTHON=%VENV%\Scripts\python.exe
set PIP=%VENV%\Scripts\pip.exe
set STAMP=%VENV%\.last_update

:: Step 1: Create venv if missing
if not exist "%PYTHON%" (
    echo 🔧 First run - setting up environment...
    python -m venv %VENV%
    if errorlevel 1 (
        echo ❌ Failed to create virtual environment.
        echo    Make sure Python 3.10+ is installed: https://python.org
        pause
        exit /b 1
    )
    echo ✅ Environment created.
    goto install
)

:: Step 2: Check if update needed (simple: just check stamp exists)
if not exist "%STAMP%" goto install
goto launch

:install
echo 📦 Installing / updating dependencies...
"%PIP%" install --upgrade -r requirements.txt -q
if errorlevel 1 (
    echo ❌ Failed to install dependencies.
    pause
    exit /b 1
)
echo %date% %time% > "%STAMP%"
echo ✅ Dependencies ready.

:launch
echo 🚀 Launching Package Collector...
"%PYTHON%" app.py
