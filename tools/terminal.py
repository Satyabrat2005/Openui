"""
Terminal tool - Execute shell commands safely.
"""

import os
import subprocess
from typing import Dict, Any

from tools.base import BaseTool
from core.helpers import (
    truncate,
    is_destructive_command,
    format_tool_result,
    run_command_safely,
)


class TerminalTool(BaseTool):
    """Execute shell/terminal commands."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "execute_terminal"

    @property
    def description(self) -> str:
        return "Execute a shell command and return output."

    def execute(self, args: Dict[str, Any]) -> str:
        command = args.get("command", "").strip()
        working_dir = args.get("working_dir")
        timeout = args.get("timeout", 30)

        if not command:
            return "ERROR: No command provided."

        # Safety check
        if self.config.safety_confirm_destructive and is_destructive_command(
            command, self.config.safety_blocked_commands
        ):
            return (
                f"BLOCKED: This command appears destructive: {command}\n"
                "If you really need to run this, the user must run it manually."
            )

        # Execute
        old_cwd = None
        if working_dir and os.path.isdir(working_dir):
            old_cwd = os.getcwd()
            os.chdir(working_dir)

        try:
            result = run_command_safely(command, timeout=timeout)
        finally:
            if old_cwd:
                os.chdir(old_cwd)

        # Format output
        max_chars = self.config.safety_max_terminal_output
        output_parts = []

        if result["stdout"]:
            output_parts.append(truncate(result["stdout"], max_chars))

        if result["stderr"]:
            output_parts.append(f"STDERR: {truncate(result['stderr'], max_chars // 2)}")

        output = "\n".join(output_parts) if output_parts else "(no output)"

        if result["returncode"] != 0:
            return format_tool_result(self.name, f"{output}\nExit code: {result['returncode']}", success=False)

        return format_tool_result(self.name, output)
