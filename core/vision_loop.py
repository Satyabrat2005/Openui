"""
Continuous Vision Loop — Background screen understanding.

Captures screenshots periodically, extracts UI elements using OCR, and falls back to
textual screen state descriptions for non-vision local LLMs (like qwen2.5-coder:7b).
"""

import io
import base64
import time
import threading
from typing import Optional, Dict, Any, Callable, List
from dataclasses import dataclass, field

@dataclass
class ScreenState:
    """Current understanding of what's on the screen."""
    timestamp: float = 0.0
    description: str = ""
    active_window: str = ""
    visible_text: str = ""
    screenshot_b64: str = ""
    elements: list = field(default_factory=list)  # Detected UI elements
    raw_width: int = 0
    raw_height: int = 0
    is_stale: bool = True  # True if older than capture_interval

    def summary(self) -> str:
        """Short summary for the agent."""
        age = time.time() - self.timestamp if self.timestamp else 999
        stale = " (STALE)" if age > 5 else ""
        elements_summary = ""
        if self.elements:
            elements_summary = "\nDetected UI Text Elements (Phrase @ x,y coordinate):\n"
            # Add up to 30 elements to keep the summary concise but informative
            for el in self.elements[:35]:
                elements_summary += f'- "{el["text"]}" at ({el["x"]}, {el["y"]})\n'
            if len(self.elements) > 35:
                elements_summary += f'- ... and {len(self.elements) - 35} more elements.'
        
        return (
            f"Screen{stale}: {self.active_window or 'Unknown window'}\n"
            f"Resolution: {self.raw_width}x{self.raw_height}\n"
            f"Description: {self.description[:800]}\n"
            f"{elements_summary}"
        )


class VisionLoop:
    """Background thread that continuously captures and analyzes the screen."""

    def __init__(self, config, router=None):
        self.config = config
        self.router = router
        self._state = ScreenState()
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._capture_interval: float = getattr(config, 'vision_capture_interval', 2.0)
        self._on_state_change: Optional[Callable] = None
        self._paused = False

    def start(self):
        """Start the background vision loop."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="VisionLoop")
        self._thread.start()
        print("[VisionLoop] Started background screen analysis.")

    def stop(self):
        """Stop the background vision loop."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        print("[VisionLoop] Stopped.")

    def pause(self):
        """Temporarily pause captures."""
        self._paused = True

    def resume(self):
        """Resume captures after pause."""
        self._paused = False

    def get_state(self) -> ScreenState:
        """Get the current screen state (thread-safe)."""
        with self._lock:
            return ScreenState(
                timestamp=self._state.timestamp,
                description=self._state.description,
                active_window=self._state.active_window,
                visible_text=self._state.visible_text,
                screenshot_b64=self._state.screenshot_b64,
                elements=list(self._state.elements),
                raw_width=self._state.raw_width,
                raw_height=self._state.raw_height,
                is_stale=self._state.is_stale,
            )

    def capture_now(self) -> ScreenState:
        """Force an immediate capture and analysis (blocking)."""
        self._do_capture()
        return self.get_state()

    def get_screenshot_b64(self, region: Optional[str] = None) -> str:
        """Capture a screenshot right now and return base64 PNG."""
        try:
            import mss
            import mss.tools

            with mss.mss() as sct:
                monitor = sct.monitors[1]

                if region:
                    parts = [int(p.strip()) for p in region.split(",")]
                    if len(parts) == 4:
                        x, y, w, h = parts
                        monitor = {
                            "left": monitor["left"] + x,
                            "top": monitor["top"] + y,
                            "width": w,
                            "height": h,
                        }

                img = sct.grab(monitor)
                buf = io.BytesIO()
                mss.tools.to_png(img.rgb, img.size, output=buf)
                png_bytes = buf.getvalue()

                try:
                    from PIL import Image
                    pil_img = Image.open(io.BytesIO(png_bytes))
                    max_dim = getattr(self.config, 'screen_max_screenshot_size', 1920)
                    if pil_img.width > max_dim or pil_img.height > max_dim:
                        ratio = min(max_dim / pil_img.width, max_dim / pil_img.height)
                        new_size = (int(pil_img.width * ratio), int(pil_img.height * ratio))
                        pil_img = pil_img.resize(new_size, Image.Resampling.LANCZOS)
                        buf2 = io.BytesIO()
                        pil_img.save(buf2, format="PNG", optimize=True)
                        png_bytes = buf2.getvalue()
                except ImportError:
                    pass

                return base64.b64encode(png_bytes).decode("utf-8")

        except Exception as e:
            print(f"[VisionLoop] Screenshot error: {e}")
            return ""

    def set_state_change_callback(self, callback: Callable):
        """Set a callback called when screen state changes significantly."""
        self._on_state_change = callback

    def _loop(self):
        """Main loop: capture -> analyze -> sleep -> repeat."""
        while self._running:
            if not self._paused:
                try:
                    self._do_capture()
                except Exception as e:
                    print(f"[VisionLoop] Capture error: {e}")

            time.sleep(self._capture_interval)

    def _group_ocr_words(self, words: List[Dict], max_dist_x: int = 25, max_dist_y: int = 8) -> List[Dict]:
        """Group separate word boxes that are horizontally adjacent on the same line into single elements/phrases."""
        if not words:
            return []
        
        # Sort top-to-bottom, left-to-right
        words = sorted(words, key=lambda w: (w['y'], w['x']))
        grouped = []
        used = set()

        for i, w1 in enumerate(words):
            if i in used:
                continue

            current_group = [w1]
            used.add(i)

            # Find matching words on the same horizontal line
            for j, w2 in enumerate(words):
                if j in used:
                    continue

                last_word = current_group[-1]
                # Check if w2 is on the same line and adjacent horizontally
                same_line = abs(w2['y'] - last_word['y']) <= max_dist_y
                adjacent = w2['x'] - (last_word['x'] + last_word['width']) <= max_dist_x

                if same_line and adjacent:
                    current_group.append(w2)
                    used.add(j)

            # Merge group attributes
            merged_text = " ".join([w['text'] for w in current_group]).strip()
            if not merged_text:
                continue

            left = min([w['x'] - w['width'] // 2 for w in current_group])
            right = max([w['x'] + w['width'] // 2 for w in current_group])
            top = min([w['y'] - w['height'] // 2 for w in current_group])
            bottom = max([w['y'] + w['height'] // 2 for w in current_group])

            grouped.append({
                "text": merged_text,
                "x": (left + right) // 2,
                "y": (top + bottom) // 2,
                "width": right - left,
                "height": bottom - top
            })
        
        return grouped

    def _generate_textual_screen_description(self, active_window: str, elements: List[Dict]) -> str:
        """Construct a textual summary of the screen based on detected UI/text elements."""
        desc = f"Active window: '{active_window}'.\n"
        if not elements:
            return desc + "The screen appears empty or no text could be recognized."
        
        desc += f"A total of {len(elements)} text blocks/elements were detected on screen:\n"
        for i, el in enumerate(elements[:40]):
            desc += f'- Block {i+1}: "{el["text"]}" located at coordinates ({el["x"]}, {el["y"]})\n'
        if len(elements) > 40:
            desc += f"... and {len(elements) - 40} other smaller text elements."
        return desc

    def _do_capture(self):
        """Capture screenshot, run OCR, run/simulate vision model."""
        try:
            import mss
            import mss.tools
        except ImportError:
            return

        try:
            # 1. Capture screenshot
            with mss.mss() as sct:
                monitor = sct.monitors[1]
                img = sct.grab(monitor)
                width, height = img.size.width, img.size.height

                buf = io.BytesIO()
                mss.tools.to_png(img.rgb, img.size, output=buf)
                png_bytes = buf.getvalue()

            b64 = base64.b64encode(png_bytes).decode("utf-8")

            # 2. Get active window title
            from core.helpers import get_active_window_title
            active_win = get_active_window_title() or "Desktop"

            # 3. OCR (fast, for text extraction & coordinates)
            visible_text = ""
            elements = []
            try:
                from PIL import Image
                import pytesseract
                pil_img = Image.open(io.BytesIO(png_bytes))
                visible_text = pytesseract.image_to_string(pil_img).strip()

                # Get coordinate details of words
                data = pytesseract.image_to_data(pil_img, output_type=pytesseract.Output.DICT)
                raw_words = []
                for i in range(len(data['text'])):
                    text = data['text'][i].strip()
                    conf = float(data['conf'][i])
                    if text and conf > 45:  # Filter out low-confidence texts
                        raw_words.append({
                            "text": text,
                            "x": data['left'][i] + data['width'][i] // 2,
                            "y": data['top'][i] + data['height'][i] // 2,
                            "width": data['width'][i],
                            "height": data['height'][i]
                        })
                # Group words into clean sentences/labels
                elements = self._group_ocr_words(raw_words)
            except Exception as e:
                print(f"[VisionLoop] OCR extraction error: {e}")

            # 4. Vision model description or local fallback
            description = ""
            is_pure_text_model = False
            if self.router:
                model_name_lower = self.router.model_name.lower()
                # Check if model is known to be text-only (e.g. qwen2.5-coder)
                if "coder" in model_name_lower or "instruct" in model_name_lower or "llama" in model_name_lower:
                    is_pure_text_model = True

            if is_pure_text_model:
                description = self._generate_textual_screen_description(active_win, elements)
            elif self.router:
                try:
                    description = self.router.describe_image(
                        b64,
                        prompt=(
                            "Describe what you see on this computer screen in detail. "
                            "List the application/window visible, any buttons, text fields, "
                            "dialog boxes, menus, and their approximate positions."
                        ),
                    )
                except Exception:
                    description = self._generate_textual_screen_description(active_win, elements)
            else:
                description = self._generate_textual_screen_description(active_win, elements)

            # 5. Update state
            with self._lock:
                old_window = self._state.active_window
                self._state.timestamp = time.time()
                self._state.description = description
                self._state.active_window = active_win
                self._state.visible_text = visible_text[:5000]
                self._state.screenshot_b64 = b64
                self._state.raw_width = width
                self._state.raw_height = height
                self._state.elements = elements
                self._state.is_stale = False

            # 6. Notify if window changed
            if self._on_state_change and old_window != active_win:
                self._on_state_change(self.get_state())

        except Exception as e:
            print(f"[VisionLoop] Analysis error: {e}")
            with self._lock:
                self._state.is_stale = True
