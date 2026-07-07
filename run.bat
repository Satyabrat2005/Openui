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

:: Ollama is OPTIONAL — chat/planning/agent runs are cloud-first (Anthropic/
:: OpenAI via the chat-proxy). Ollama is only used for local RAG embeddings
:: and the self-improvement job, so its absence should warn, not block launch.
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Ollama not found in PATH — local knowledge-base embeddings and the
    echo        self-improvement job will be unavailable. Chat still works via the
    echo        cloud. To enable them, install from https://ollama.com/download
    echo        then run: ollama pull llama3:8b
    goto launch
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
    echo [WARNING] Ollama did not respond in time — RAG/self-improvement features
    echo           will be unavailable this session; chat is unaffected.
    goto launch
)
:ollama_ready

:: Best-effort: ensure the default embeddings model is pulled. Non-fatal if
:: this fails or Ollama isn't reachable — it only affects RAG/self-improvement.
echo Ensuring the local model is available (ollama pull llama3:8b)...
ollama pull llama3:8b
if %errorlevel% neq 0 (
    echo [WARNING] Could not pull llama3:8b — RAG/self-improvement features may be unavailable.
)

:launch

:: Launch OpenUI in development mode (electron-vite watch + Electron window).
echo Launching OpenUI...
call npm run dev
exit /b %errorlevel%
