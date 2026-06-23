"""
Floating overlay UI - Shows OpenUI status, responses, and input.
Built with PyQt5 for cross-platform support.
"""

import sys
import threading
from typing import Optional, Callable

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit,
    QTextEdit, QPushButton, QFrame, QSizePolicy,
)
from PyQt5.QtCore import (
    Qt, QPoint, QSize, pyqtSignal, QTimer, QRectF,
)
from PyQt5.QtGui import (
    QPainter, QColor, QFont, QPen, QPainterPath,
    QKeySequence, QShortcut, QPixmap, QIcon,
)


class OverlayWindow(QWidget):
    """Floating overlay that shows OpenUI status and accepts commands."""

    # Signal emitted when user submits a command
    command_submitted = pyqtSignal(str)
    # Signal to start/stop voice listening
    voice_toggled = pyqtSignal(bool)

    def __init__(self, config, parent=None):
        super().__init__(parent)
        self.config = config
        self._command_callback: Optional[Callable] = None
        self._drag_pos = None
        self._is_listening = False

        self._setup_window()
        self._build_ui()
        self._apply_theme()

    def _setup_window(self):
        """Configure window properties for always-on-top overlay."""
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(380, 520)

        # Position top-right
        from PyQt5.QtWidgets import QDesktopWidget
        screen = QDesktopWidget().availableGeometry()
        self.move(
            screen.right() - self.width() - 20,
            screen.top() + 20,
        )

    def _build_ui(self):
        """Build the UI layout."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Main container frame
        self.container = QFrame()
        self.container.setObjectName("container")
        container_layout = QVBoxLayout(self.container)
        container_layout.setContentsMargins(16, 16, 16, 16)
        container_layout.setSpacing(8)

        # Header bar
        header = QHBoxLayout()
        header.setSpacing(8)

        self.status_dot = QLabel("\u25CF")  # Circle
        self.status_dot.setFont(QFont("Arial", 12))
        self.status_dot.setStyleSheet("color: #22c55e;")

        self.title_label = QLabel("OpenUI")
        self.title_label.setFont(QFont("Inter", 14, QFont.Bold))
        self.title_label.setStyleSheet("color: #1e293b;")

        header.addStretch()

        self.minimize_btn = QPushButton("\u2014")
        self.minimize_btn.setFixedSize(24, 24)
        self.minimize_btn.clicked.connect(self.toggle_visibility)
        self.minimize_btn.setObjectName("headerBtn")

        self.close_btn = QPushButton("\u00D7")
        self.close_btn.setFixedSize(24, 24)
        self.close_btn.clicked.connect(self.hide)
        self.close_btn.setObjectName("headerBtn")

        header.addWidget(self.status_dot)
        header.addWidget(self.title_label)
        header.addWidget(self.minimize_btn)
        header.addWidget(self.close_btn)
        container_layout.addLayout(header)

        # Response display area
        self.response_area = QTextEdit()
        self.response_area.setReadOnly(True)
        self.response_area.setPlaceholderText("OpenUI is ready. Type a command or press Ctrl+Alt+O to speak...")
        self.response_area.setFont(QFont("Inter", 12))
        self.response_area.setObjectName("responseArea")
        self.response_area.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        container_layout.addWidget(self.response_area)

        # Status bar
        self.status_label = QLabel("Ready")
        self.status_label.setFont(QFont("Inter", 10))
        self.status_label.setStyleSheet("color: #94a3b8;")
        container_layout.addWidget(self.status_label)

        # Input row
        input_layout = QHBoxLayout()
        input_layout.setSpacing(8)

        self.input_field = QLineEdit()
        self.input_field.setPlaceholderText("Type a command...")
        self.input_field.setFont(QFont("Inter", 12))
        self.input_field.setObjectName("inputField")
        self.input_field.returnPressed.connect(self._on_submit)
        input_layout.addWidget(self.input_field)

        self.voice_btn = QPushButton("\U0001F3A4")
        self.voice_btn.setFixedSize(40, 40)
        self.voice_btn.setFont(QFont("Arial", 16))
        self.voice_btn.setObjectName("voiceBtn")
        self.voice_btn.clicked.connect(self._toggle_voice)
        input_layout.addWidget(self.voice_btn)

        self.send_btn = QPushButton("\u27A4")
        self.send_btn.setFixedSize(40, 40)
        self.send_btn.setFont(QFont("Arial", 16))
        self.send_btn.setObjectName("sendBtn")
        self.send_btn.clicked.connect(self._on_submit)
        input_layout.addWidget(self.send_btn)

        container_layout.addLayout(input_layout)
        layout.addWidget(self.container)

    def _apply_theme(self):
        """Apply theme styling."""
        is_dark = self.config.ui_theme == "dark"
        bg = "#1e293b" if is_dark else "#ffffff"
        fg = "#e2e8f0" if is_dark else "#1e293b"
        border = "#334155" if is_dark else "#e2e8f0"
        input_bg = "#0f172a" if is_dark else "#f8fafc"

        self.container.setStyleSheet(f"""
            QFrame#container {{
                background: {bg};
                border: 1px solid {border};
                border-radius: 16px;
            }}
            QTextEdit#responseArea {{
                background: transparent;
                color: {fg};
                border: none;
                padding: 8px;
            }}
            QLineEdit#inputField {{
                background: {input_bg};
                color: {fg};
                border: 1px solid {border};
                border-radius: 10px;
                padding: 8px 12px;
            }}
            QLineEdit#inputField:focus {{
                border-color: #3b82f6;
            }}
            QPushButton#sendBtn {{
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 10px;
            }}
            QPushButton#sendBtn:hover {{
                background: #2563eb;
            }}
            QPushButton#voiceBtn {{
                background: {input_bg};
                color: {fg};
                border: 1px solid {border};
                border-radius: 10px;
            }}
            QPushButton#voiceBtn:hover {{
                background: #ef4444;
                color: white;
            }}
            QPushButton#headerBtn {{
                background: transparent;
                color: {fg};
                border: none;
                border-radius: 6px;
                font-size: 14px;
            }}
            QPushButton#headerBtn:hover {{
                background: {border};
            }}
        """)

    def _on_submit(self):
        """Handle command submission."""
        text = self.input_field.text().strip()
        if text:
            self.input_field.clear()
            self.command_submitted.emit(text)

    def _toggle_voice(self):
        """Toggle voice listening."""
        self._is_listening = not self._is_listening
        self.voice_toggled.emit(self._is_listening)

        if self._is_listening:
            self.voice_btn.setStyleSheet(
                "background: #ef4444; color: white; border: none; border-radius: 10px; font-size: 16px;"
            )
            self.set_status("Listening...", color="#ef4444")
        else:
            self.voice_btn.setStyleSheet("")

    def set_response(self, text: str):
        """Update the response display area."""
        self.response_area.setPlainText(text)
        # Auto-scroll to bottom
        scrollbar = self.response_area.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def append_response(self, text: str):
        """Append text to the response area."""
        current = self.response_area.toPlainText()
        self.response_area.setPlainText(current + "\n" + text)
        scrollbar = self.response_area.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def set_status(self, text: str, color: str = "#94a3b8"):
        """Update the status label."""
        self.status_label.setText(text)
        self.status_label.setStyleSheet(f"color: {color};")

    def set_listening_state(self, listening: bool):
        """Update voice listening state from external."""
        self._is_listening = listening
        if listening:
            self.voice_btn.setStyleSheet(
                "background: #ef4444; color: white; border: none; border-radius: 10px; font-size: 16px;"
            )
            self.set_status("Listening...", color="#ef4444")
        else:
            self.voice_btn.setStyleSheet("")
            self.set_status("Ready")

    def set_thinking(self, thinking: bool):
        """Show thinking state."""
        if thinking:
            self.status_dot.setStyleSheet("color: #f59e0b;")
            self.set_status("Thinking...", color="#f59e0b")
        else:
            self.status_dot.setStyleSheet("color: #22c55e;")
            self.set_status("Ready")

    def toggle_visibility(self):
        """Minimize to tray / restore."""
        if self.isVisible():
            self.hide()
        else:
            self.show()
            self.raise_()

    def mousePressEvent(self, event):
        """Enable window dragging."""
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPos() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        """Handle window dragging."""
        if event.buttons() == Qt.LeftButton and self._drag_pos:
            self.move(event.globalPos() - self._drag_pos)
            event.accept()

    def mouseReleaseEvent(self, event):
        """Stop dragging."""
        self._drag_pos = None
