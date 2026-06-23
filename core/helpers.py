"""Utility helper functions."""

import os
import sys
import platform
import subprocess
import time
from pathlib import Path
from typing import Optional


def truncate(text: str, max_chars: int = 5000, suffix: str = "...") -> str:
    """Truncate text to max_chars, preserving whole lines."""
    if len(text) <= max_chars:
        return text
    cutoff = max_chars - len(suffix)
    lines = text[:cutoff].split("\n")
    lines[-1] = lines[-1] + suffix
    return "\n".join(lines)


def count_lines(text: str) -> int:
    return text.count("\n") + 1


def ensure_dir(path: str) -> Path:
    """Create directory if it doesn't exist, return Path."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_platform() -> str:
    """Get normalized platform name."""
    s = platform.system().lower()
    if s == "windows":
        return "windows"
    elif s == "darwin":
        return "macos"
    return "linux"


def is_destructive_command(command: str, blocked: list) -> bool:
    """Check if a terminal command is potentially destructive."""
    cmd_lower = command.strip().lower()
    for blocked_cmd in blocked:
        if blocked_cmd.lower() in cmd_lower:
            return True
    # Additional heuristics
    dangerous_patterns = [
        "rm -rf /", "rm -rf /*", "mkfs.", "dd if=/dev/zero",
        "> /dev/sd", "chmod -R 777 /", ":(){ :|:& };:",
    ]
    for pattern in dangerous_patterns:
        if pattern in cmd_lower:
            return True
    return False


def run_command_safely(command: str, timeout: int = 30) -> dict:
    """Run a shell command and return {stdout, stderr, returncode}."""
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"Command timed out after {timeout}s", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}


def format_tool_result(tool_name: str, result: str, success: bool = True) -> str:
    """Format a tool execution result for the LLM."""
    status = "SUCCESS" if success else "ERROR"
    return f"[{tool_name}] {status}:\n{result}"


def check_ollama_running(base_url: str = "http://localhost:11434") -> bool:
    """Check if Ollama server is running."""
    try:
        import requests
        resp = requests.get(f"{base_url}/api/tags", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def check_model_available(base_url: str, model_name: str) -> bool:
    """Check if a specific model is available in Ollama."""
    try:
        import requests
        resp = requests.get(f"{base_url}/api/tags", timeout=5)
        if resp.status_code == 200:
            models = resp.json().get("models", [])
            for m in models:
                if model_name in m.get("name", ""):
                    return True
        return False
    except Exception:
        return False


def install_model(model_name: str, base_url: str = "http://localhost:11434") -> bool:
    """Pull a model from Ollama registry."""
    try:
        import requests
        resp = requests.post(
            f"{base_url}/api/pull",
            json={"name": model_name, "stream": False},
            timeout=600,  # models can be large
        )
        return resp.status_code == 200
    except Exception:
        return False


def get_active_window_title() -> str:
    """Get the title of the currently focused window."""
    try:
        # Prefer pygetwindow if available
        import importlib
        gw = importlib.import_module("pygetwindow")
        win = gw.getActiveWindow()
        return win.title if win else ""
    except Exception:
        # Fallback implementations per platform to avoid hard dependency
        try:
            sys_plat = platform.system().lower()
            if sys_plat == "windows":
                import ctypes
                user32 = ctypes.windll.user32
                kernel32 = ctypes.windll.kernel32
                hwnd = user32.GetForegroundWindow()
                length = user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                return buf.value
            elif sys_plat == "darwin":
                try:
                    from AppKit import NSWorkspace
                    active_app = NSWorkspace.sharedWorkspace().frontmostApplication()
                    return active_app.localizedName() or ""
                except Exception:
                    return ""
            else:
                # Try xprop for X11 based systems
                try:
                    p = subprocess.run(["xdotool", "getwindowfocus", "getwindowname"], capture_output=True, text=True, timeout=1)
                    if p.returncode == 0:
                        return p.stdout.strip()
                except Exception:
                    pass
                try:
                    p = subprocess.run(["xprop", "-id", "$(xprop -root _NET_ACTIVE_WINDOW | awk '{print $5}')", "WM_NAME"], shell=True, capture_output=True, text=True, timeout=1)
                    if p.returncode == 0:
                        out = p.stdout
                        # parse WM_NAME="title"
                        if '"' in out:
                            return out.split('"', 1)[1].rsplit('"', 1)[0]
                except Exception:
                    pass
                return ""
        except Exception:
            return ""


def get_screen_resolution() -> tuple:
    """Get screen width, height."""
    try:
        try:
            import pyautogui
            return pyautogui.size()
        except ImportError:
            import tkinter as tk
            root = tk.Tk()
            width = root.winfo_screenwidth()
            height = root.winfo_screenheight()
            root.destroy()
            return (width, height)
    except Exception:
        return (1920, 1080)
