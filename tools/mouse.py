"""
Mouse control tools - Click, scroll, drag.
"""

import time
from typing import Dict, Any

from tools.base import BaseTool
from core.helpers import format_tool_result


class MouseClickTool(BaseTool):
    """Click the mouse at coordinates."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "mouse_click"

    @property
    def description(self) -> str:
        return "Click the mouse at specific coordinates."

    def execute(self, args: Dict[str, Any]) -> str:
        x = args.get("x")
        y = args.get("y")
        button = args.get("button", "left")
        clicks = args.get("clicks", 1)

        if x is None or y is None:
            return "ERROR: x and y coordinates are required."

        try:
            import pyautogui
            pyautogui.PAUSE = 0.1

            # Move to position first
            pyautogui.moveTo(x, y, duration=0.15)

            # Click
            pyautogui.click(x=x, y=y, clicks=clicks, button=button)

            action = f"{'double-' if clicks == 2 else ''}{button} click"
            return format_tool_result(self.name, f"{action} at ({x}, {y})")

        except Exception as e:
            return format_tool_result(self.name, f"Click failed: {e}", success=False)


class MouseScrollTool(BaseTool):
    """Scroll the mouse wheel."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "mouse_scroll"

    @property
    def description(self) -> str:
        return "Scroll the mouse wheel."

    def execute(self, args: Dict[str, Any]) -> str:
        clicks = args.get("clicks", 0)
        x = args.get("x")
        y = args.get("y")

        try:
            import pyautogui
            pyautogui.PAUSE = 0.1

            if x is not None and y is not None:
                pyautogui.scroll(clicks, x=x, y=y)
                return format_tool_result(self.name, f"Scrolled {clicks} clicks at ({x}, {y})")
            else:
                pyautogui.scroll(clicks)
                direction = "up" if clicks > 0 else "down"
                return format_tool_result(self.name, f"Scrolled {abs(clicks)} clicks {direction}")

        except Exception as e:
            return format_tool_result(self.name, f"Scroll failed: {e}", success=False)


class MouseDragTool(BaseTool):
    """Click and drag from one point to another."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "mouse_drag"

    @property
    def description(self) -> str:
        return "Drag the mouse from one point to another."

    def execute(self, args: Dict[str, Any]) -> str:
        sx = args.get("start_x")
        sy = args.get("start_y")
        ex = args.get("end_x")
        ey = args.get("end_y")

        if any(v is None for v in [sx, sy, ex, ey]):
            return "ERROR: start_x, start_y, end_x, end_y are all required."

        try:
            import pyautogui
            pyautogui.PAUSE = 0.1

            # Move to start
            pyautogui.moveTo(sx, sy, duration=0.15)
            # Drag to end
            pyautogui.drag(ex - sx, ey - sy, duration=0.5)

            return format_tool_result(self.name, f"Dragged from ({sx},{sy}) to ({ex},{ey})")

        except Exception as e:
            return format_tool_result(self.name, f"Drag failed: {e}", success=False)
