@echo off
title OpenUI - Local AI Desktop Assistant
echo ==========================================================
echo                Starting OpenUI (Electron)
echo ==========================================================
echo.

:: -------------------------------------------------------------------------
:: This script used to claim Ollama was OPTIONAL and that runs were
:: "cloud-first", then pull llama3:8b. All three statements were wrong and
:: contradicted the README:
::   * the cloud tier ships OFF (OPENUI_ENABLE_CLOUD is unset by default), so
::     chat, planning and the coding agent are Ollama-only;
::   * the app has never used llama3:8b — the defaults are qwen3.5 (general)
::     and qwen2.5-coder:7b (coding);
::   * without a local model nothing works at all, so its absence is fatal to
::     the app's core function, not a warning about "RAG features".
:: The app now downloads a missing model itself, with progress in the UI
:: (main/ollamaPull.ts), so this script no longer pulls anything — it only
:: makes sure the engine is reachable and says what will happen.
:: -------------------------------------------------------------------------

:: Check Node.js installation
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

:: Ollama is REQUIRED: every chat, plan and coding turn streams from it.
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Ollama was not found in PATH, and OpenUI needs it for every
    echo         chat, plan and coding turn. The optional cloud tier ships
    echo         DISABLED, so there is no fallback.
    echo.
    echo         Install it from https://ollama.com/download and run this again.
    pause
    exit /b 1
)

echo Checking local Ollama server...
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel% neq 0 (
    echo Ollama is not running. Starting "ollama serve" in a new window...
    start "Ollama Server" cmd /c "ollama serve"
    :: Wait for the server to accept connections (up to ~20s).
    for /l %%i in (1,1,10) do (
        timeout /t 2 >nul
        powershell -Command "try { Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
        if not errorlevel 1 goto ollama_ready
    )
    echo [WARNING] Ollama did not respond in time. OpenUI will try to start it
    echo           again itself; if chat reports the engine is unreachable, run
    echo           "ollama serve" in a terminal and retry.
)
:ollama_ready

:: Report what is installed, so a first-run user knows a download is coming.
:: OpenUI pulls a missing model itself and shows real progress in the app, so
:: there is deliberately no "ollama pull" here.
echo.
echo Local models currently installed:
ollama list
echo.
echo OpenUI expects qwen3.5 (general) and qwen2.5-coder:7b (coding).
echo If neither is present, OpenUI downloads what it needs on the first turn
echo and shows progress in the app. That is a few GB, one time only.
echo.

:: Launch OpenUI in development mode (electron-vite watch + Electron window).
echo Launching OpenUI...
call npm run dev
exit /b %errorlevel%
