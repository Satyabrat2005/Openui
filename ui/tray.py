"""
System tray icon for OpenUI.
Provides quick access to the overlay and voice commands.
"""

import sys
from typing import Optional, Callable

from PyQt5.QtWidgets import QSystemTrayIcon, QMenu, QAction
from PyQt5.QtGui import QIcon, QPixmap, QPainter, QColor, QFont


def create_tray_icon(
    app_icon=None,
    on_show_overlay: Optional[Callable] = None,
    on_toggle_voice: Optional[Callable] = None,
    on_quit: Optional[Callable] = None,
) -> QSystemTrayIcon:
    """Create and configure the system tray icon.

    Args:
        app_icon: QIcon or path to icon
        on_show_overlay: Callback to show/hide the overlay
        on_toggle_voice: Callback to start/stop voice
        on_quit: Callback to quit the app

    Returns:
        Configured QSystemTrayIcon
    """
    tray = QSystemTrayIcon()

    # Create icon if none provided
    if app_icon is None:
        app_icon = _create_default_icon()

    tray.setIcon(app_icon)
    tray.setToolTip("OpenUI - Local AI Assistant")

    # Build context menu
    menu = QMenu()
    menu.setStyleSheet("""
        QMenu {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 4px;
        }
        QAction {
            padding: 8px 24px;
            color: #1e293b;
        }
        QAction:hover {
            background: #f1f5f9;
            border-radius: 4px;
        }
    """)

    # Show/Hide Overlay
    show_action = QAction("Show OpenUI", menu)
    if on_show_overlay:
        show_action.triggered.connect(on_show_overlay)
    menu.addAction(show_action)

    # Toggle Voice
    voice_action = QAction("Start Voice Input  (Ctrl+Alt+O)", menu)
    if on_toggle_voice:
        voice_action.triggered.connect(on_toggle_voice)
    menu.addAction(voice_action)

    menu.addSeparator()

    # Quit
    quit_action = QAction("Quit OpenUI", menu)
    if on_quit:
        quit_action.triggered.connect(on_quit)
    menu.addAction(quit_action)

    tray.setContextMenu(menu)

    # Click to show overlay
    if on_show_overlay:
        tray.activated.connect(lambda reason: (
            on_show_overlay() if reason == QSystemTrayIcon.Trigger else None
        ))

    return tray


def _create_default_icon() -> QIcon:
    """Create a simple OpenUI icon programmatically."""
    pixmap = QPixmap(64, 64)
    pixmap.fill(QColor(0, 0, 0, 0))  # Transparent

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing)

    # Blue circle background
    painter.setBrush(QColor("#3b82f6"))
    painter.setPen(QPen(QColor("#2563eb"), 2))
    painter.drawEllipse(2, 2, 60, 60)

    # "O" text
    painter.setPen(QColor("#ffffff"))
    font = QFont("Arial", 36, QFont.Bold)
    painter.setFont(font)
    painter.drawText(pixmap.rect(), Qt.AlignCenter, "O")

    painter.end()

    return QIcon(pixmap)
