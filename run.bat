@echo off
title OpenUI - Local AI Desktop Automation
echo ==========================================================
echo               Starting OpenUI Local AI Agent              
echo ==========================================================
echo.

:: Check Python installation
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.10+ and check 'Add Python to PATH'.
    pause
    exit /b 1
)

:: Check if requirements are installed
echo Checking dependencies...
python -c "import PyQt5, selenium, faster_whisper, pyttsx3" >nul 2>nul
if %errorlevel% neq 0 (
    echo Install missing dependencies...
    python -m pip install -r requirements.txt
)

:: Check Ollama status
echo Checking local Ollama service...
powershell -Command "Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing" >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Ollama is not running!
    echo Attempting to start Ollama automatically...
    start "" "%LocalAppData%\Programs\Ollama\ollama app.exe"
    timeout /t 5 >nul
)

:: Double check if Ollama started
powershell -Command "Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing" >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Could not start Ollama automatically. 
    echo Please make sure Ollama is installed and running, then press any key.
    pause
)

:: Start the application
echo Launching OpenUI...
start "" pythonw main.py
exit /b 0
