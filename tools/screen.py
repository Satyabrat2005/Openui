"""
Screen tools - Capture screenshots and read text via OCR.
"""

import base64
import io
from typing import Dict, Any

from tools.base import BaseTool
from core.helpers import format_tool_result, truncate


class CaptureScreenTool(BaseTool):
    """Take a screenshot and return it as base64."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "capture_screen"

    @property
    def description(self) -> str:
        return "Capture a screenshot (full screen or region)."

    def execute(self, args: Dict[str, Any]) -> str:
        region_str = args.get("region")

        try:
            import mss
            import mss.tools
        except ImportError:
            return "ERROR: mss package not installed. Run: pip install mss"

        try:
            with mss.mss() as sct:
                monitor = sct.monitors[1]  # Primary monitor

                if region_str:
                    # Parse "x,y,width,height"
                    parts = [int(p.strip()) for p in region_str.split(",")]
                    if len(parts) == 4:
                        x, y, w, h = parts
                        monitor = {
                            "left": monitor["left"] + x,
                            "top": monitor["top"] + y,
                            "width": w,
                            "height": h,
                        }

                # Capture at scale
                scale = self.config.screen_capture_scale
                img = sct.grab(monitor)

                # Convert to PNG bytes
                buf = io.BytesIO()
                mss.tools.to_png(img.rgb, img.size, output=buf)
                png_bytes = buf.getvalue()

                # Encode to base64
                b64 = base64.b64encode(png_bytes).decode("utf-8")
                size_kb = len(png_bytes) // 1024

                return format_tool_result(
                    self.name,
                    f"Screenshot captured ({img.size.width}x{img.size.height}, {size_kb}KB).\n"
                    f"Base64 image data: {b64[:100]}..."
                    f"\n[Image data is {len(b64)} chars of base64 — it can be passed to vision models]"
                )

        except Exception as e:
            return format_tool_result(self.name, f"Screenshot failed: {e}", success=False)


class ReadScreenTextTool(BaseTool):
    """Read text on screen using OCR."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "read_screen_text"

    @property
    def description(self) -> str:
        return "Read visible text on screen using OCR."

    def execute(self, args: Dict[str, Any]) -> str:
        region_str = args.get("region")
        lang = args.get("lang", "eng")

        try:
            import mss
            import mss.tools
            from PIL import Image
        except ImportError:
            return "ERROR: Required packages not installed. Run: pip install mss Pillow"

        try:
            # Capture screen
            with mss.mss() as sct:
                monitor = sct.monitors[1]
                if region_str:
                    parts = [int(p.strip()) for p in region_str.split(",")]
                    if len(parts) == 4:
                        x, y, w, h = parts
                        monitor = {
                            "left": monitor["left"] + x,
                            "top": monitor["top"] + y,
                            "width": w,
                            "height": h,
                        }

                img = sct.grab(monitor)
                pil_img = Image.frombytes("RGB", img.size, img.rgb)

            # OCR
            import pytesseract
            text = pytesseract.image_to_string(pil_img, lang=lang).strip()

            if not text:
                return format_tool_result(self.name, "No text detected on screen.")

            return format_tool_result(self.name, truncate(text, 3000))

        except ImportError:
            return (
                "ERROR: pytesseract not installed.\n"
                "Install Tesseract OCR: https://github.com/tesseract-ocr/tesseract\n"
                "Then: pip install pytesseract"
            )
        except Exception as e:
            return format_tool_result(self.name, f"OCR failed: {e}", success=False)
