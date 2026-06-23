from setuptools import setup, find_packages

setup(
    name="openui",
    version="0.1.0",
    description="OpenUI - Local-First OS Assistant",
    author="OpenUI Team",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "openai>=1.12.0",
        "requests>=2.31.0",
        "pyyaml>=6.0.1",
        "rich>=13.7.0",
        "mss>=9.0.0",
        "Pillow>=10.0.0",
        "pytesseract>=0.3.10",
        "pyautogui>=0.9.54",
        "pynput>=1.7.6",
        "pygetwindow>=0.0.9",
        "pyperclip>=1.8.2",
        "psutil>=5.9.5",
        "pyttsx3>=2.90",
        "PyQt5>=5.15.10",
    ],
    entry_points={
        "console_scripts": ["openui=main:main"],
    },
)
