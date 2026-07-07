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

# Ollama is OPTIONAL — chat/planning/agent runs are cloud-first (Anthropic/
# OpenAI via the chat-proxy). Ollama is only used for local RAG embeddings
# and the self-improvement job, so its absence should warn, not block launch.
if ! command -v ollama >/dev/null 2>&1; then
    echo "[INFO] Ollama not found in PATH — local knowledge-base embeddings and the"
    echo "       self-improvement job will be unavailable. Chat still works via the"
    echo "       cloud. To enable them, install from https://ollama.com/download"
    echo "       then run: ollama pull llama3:8b"
else
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
            echo "[WARNING] Ollama did not respond in time — RAG/self-improvement features"
            echo "          will be unavailable this session; chat is unaffected."
        fi
    fi

    if curl -sf -m 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
        # Best-effort: ensure the default embeddings model is pulled. Non-fatal
        # if this fails — it only affects RAG/self-improvement.
        echo "Ensuring the local model is available (ollama pull llama3:8b)..."
        if ! ollama pull llama3:8b; then
            echo "[WARNING] Could not pull llama3:8b — RAG/self-improvement features may be unavailable."
        fi
    fi
fi

# Launch OpenUI in development mode (electron-vite watch + Electron window).
echo "Launching OpenUI..."
exec npm run dev
