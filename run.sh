#!/usr/bin/env bash
# OpenUI launcher for macOS/Linux — mirrors run.bat's logic.
set -u
cd "$(dirname "$0")"

echo "=========================================================="
echo "               Starting OpenUI (Electron)"
echo "=========================================================="
echo

# Check Node.js installation
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed or not in PATH."
    echo "Please install Node.js 20 LTS or later from https://nodejs.org"
    exit 1
fi

# Install dependencies on first run (no node_modules yet)
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies (first run)..."
    if ! npm install; then
        echo "[ERROR] npm install failed."
        exit 1
    fi
fi

# -----------------------------------------------------------------------------
# This block used to claim Ollama was OPTIONAL and that runs were "cloud-first",
# then pull llama3:8b. All three statements were wrong and contradicted the
# README: the cloud tier ships OFF (OPENUI_ENABLE_CLOUD unset), so chat, planning
# and the coding agent are Ollama-only; the app has never used llama3:8b (the
# defaults are qwen3.5 and qwen2.5-coder:7b); and with no local model nothing
# works at all, which is fatal rather than a warning about "RAG features".
# The app now downloads a missing model itself with progress in the UI
# (main/ollamaPull.ts), so this script no longer pulls anything.
# -----------------------------------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
    echo "[ERROR] Ollama was not found in PATH, and OpenUI needs it for every chat,"
    echo "        plan and coding turn. The optional cloud tier ships DISABLED, so"
    echo "        there is no fallback."
    echo
    echo "        Install it from https://ollama.com/download and run this again."
    exit 1
fi

echo "Checking local Ollama server..."
if ! curl -sf -m 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "Ollama is not running. Starting \"ollama serve\" in the background..."
    nohup ollama serve >/tmp/openui-ollama-serve.log 2>&1 &
    ready=0
    for _ in $(seq 1 10); do
        sleep 2
        if curl -sf -m 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
            ready=1
            break
        fi
    done
    if [ "$ready" -eq 0 ]; then
        echo "[WARNING] Ollama did not respond in time. OpenUI will try to start it"
        echo "          again itself; if chat reports the engine is unreachable, run"
        echo "          \"ollama serve\" in a terminal and retry."
    fi
fi

# Report what is installed, so a first-run user knows a download is coming.
# OpenUI pulls a missing model itself and shows real progress in the app, so
# there is deliberately no "ollama pull" here.
if curl -sf -m 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo
    echo "Local models currently installed:"
    ollama list
    echo
    echo "OpenUI expects qwen3.5 (general) and qwen2.5-coder:7b (coding)."
    echo "If neither is present, OpenUI downloads what it needs on the first turn"
    echo "and shows progress in the app. That is a few GB, one time only."
    echo
fi

# Launch OpenUI in development mode (electron-vite watch + Electron window).
echo "Launching OpenUI..."
exec npm run dev
