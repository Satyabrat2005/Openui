#!/usr/bin/env bash
# Double-clickable Finder entry point for macOS — just delegates to run.sh.
cd "$(dirname "$0")"
exec ./run.sh
