@echo off
title OpenUI - Local AI Desktop Assistant
echo ==========================================================
echo                Starting OpenUI (Electron)
echo ==========================================================
echo.

:: Check Node.js installation (Electron app — replaces the old Python launcher)
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 20 LTS or later from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies on first run (no node_modules yet)
if not exist "node_modules" (
    echo Installing dependencies (first run)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Ollama powers the free tier. Try to start it if it isn't already running.
echo Checking local Ollama service (free tier)...
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Ollama is not running. Attempting to start it...
    start "" "%LocalAppData%\Programs\Ollama\ollama app.exe"
    timeout /t 5 >nul
)

:: Launch OpenUI in development mode (electron-vite watch + Electron window).
echo Launching OpenUI...
call npm run dev
exit /b %errorlevel%
