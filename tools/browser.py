"""
Browser Tool — Selenium-based web automation.
Allows the agent to navigate, click, type, and extract info from web pages programmatically.
"""

import time
from typing import Dict, Any, Optional
# pyrefly: ignore [missing-import]
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.edge.options import Options as EdgeOptions

from tools.base import BaseTool
from core.helpers import format_tool_result


class SeleniumBrowser:
    """Singleton/Shared Selenium browser instance for the session."""
    _driver: Optional[webdriver.Remote] = None

    @classmethod
    def get_driver(cls, config) -> webdriver.Remote:
        if cls._driver is not None:
            # Check if browser is still responsive
            try:
                cls._driver.title
                return cls._driver
            except Exception:
                cls.close()

        # Try launching Chrome first, then Edge, then Firefox
        options = ChromeOptions()
        # Enable options that make it robust
        options.add_argument("--disable-gpu")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--start-maximized")
        # Run in headful mode by default so user can see it, but allow override
        if getattr(config, 'browser_headless', False):
            options.add_argument("--headless=new")

        try:
            print("[Browser] Launching Chrome driver...")
            cls._driver = webdriver.Chrome(options=options)
            return cls._driver
        except Exception as e:
            print(f"[Browser] Chrome launch failed: {e}. Trying Edge...")

        # Fallback to Edge
        edge_options = EdgeOptions()
        if getattr(config, 'browser_headless', False):
            edge_options.add_argument("--headless=new")
        edge_options.add_argument("--disable-gpu")
        edge_options.add_argument("--no-sandbox")

        try:
            cls._driver = webdriver.Edge(options=edge_options)
            return cls._driver
        except Exception as e2:
            print(f"[Browser] Edge launch failed: {e2}.")
            raise RuntimeError(f"Could not launch Chrome or Edge via Selenium: {e} | {e2}")

    @classmethod
    def close(cls):
        if cls._driver:
            try:
                cls._driver.quit()
            except Exception:
                pass
            cls._driver = None
            print("[Browser] Driver closed.")


class OpenBrowserTool(BaseTool):
    """Open a URL in Selenium browser."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "open_browser"

    @property
    def description(self) -> str:
        return "Open a URL in the automated web browser. Arguments: url (str)"

    def execute(self, args: Dict[str, Any]) -> str:
        url = args.get("url", "").strip()
        if not url:
            return "ERROR: No URL provided."

        if not url.startswith(("http://", "https://")):
            url = "https://" + url

        try:
            driver = SeleniumBrowser.get_driver(self.config)
            driver.get(url)
            # Wait a moment for page load
            time.sleep(2)
            return format_tool_result(self.name, f"Navigated browser to: {url} (Title: '{driver.title}')")
        except Exception as e:
            return format_tool_result(self.name, f"Failed to navigate: {e}", success=False)


class BrowserClickTool(BaseTool):
    """Click an element in Selenium browser."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "browser_click"

    @property
    def description(self) -> str:
        return (
            "Click a button or link on the page using a selector. "
            "Arguments: selector (str), by ('css', 'xpath', 'id', 'text', 'name')"
        )

    def execute(self, args: Dict[str, Any]) -> str:
        selector = args.get("selector", "")
        by_type = args.get("by", "css").lower()

        if not selector:
            return "ERROR: No selector provided."

        try:
            driver = SeleniumBrowser.get_driver(self.config)
            by = self._get_by_type(by_type, selector)
            if by_type == "text":
                selector = f"//*[contains(text(), '{selector}')]"
                by = By.XPATH

            element = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((by, selector))
            )
            # Scroll to element before clicking
            driver.execute_script("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", element)
            time.sleep(0.5)
            element.click()
            time.sleep(1)  # Wait for click action to register/load
            return format_tool_result(self.name, f"Successfully clicked element: {selector}")
        except Exception as e:
            return format_tool_result(self.name, f"Failed to click element {selector}: {e}", success=False)

    def _get_by_type(self, by_type: str, selector: str) -> By:
        if by_type == "css":
            return By.CSS_SELECTOR
        elif by_type == "xpath":
            return By.XPATH
        elif by_type == "id":
            return By.ID
        elif by_type == "name":
            return By.NAME
        else:
            return By.CSS_SELECTOR


class BrowserTypeTextTool(BaseTool):
    """Type text into an input element in Selenium browser."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "browser_type"

    @property
    def description(self) -> str:
        return (
            "Type text into an input field. "
            "Arguments: selector (str), text (str), by ('css', 'xpath', 'id', 'name'), clear (bool)"
        )

    def execute(self, args: Dict[str, Any]) -> str:
        selector = args.get("selector", "")
        text = args.get("text", "")
        by_type = args.get("by", "css").lower()
        clear = args.get("clear", True)

        if not selector:
            return "ERROR: No selector provided."

        try:
            driver = SeleniumBrowser.get_driver(self.config)
            by = BrowserClickTool._get_by_type(None, by_type, selector)

            element = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((by, selector))
            )
            driver.execute_script("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", element)
            time.sleep(0.5)

            if clear:
                element.clear()

            element.send_keys(text)
            return format_tool_result(self.name, f"Typed '{text}' into element: {selector}")
        except Exception as e:
            return format_tool_result(self.name, f"Failed to type into {selector}: {e}", success=False)


class BrowserExtractTool(BaseTool):
    """Extract page text or HTML."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "browser_extract"

    @property
    def description(self) -> str:
        return "Extract text, page title, or HTML source from browser. Arguments: type ('text' | 'html' | 'title')"

    def execute(self, args: Dict[str, Any]) -> str:
        extract_type = args.get("type", "text").lower()

        try:
            driver = SeleniumBrowser.get_driver(self.config)
            if extract_type == "html":
                return format_tool_result(self.name, driver.page_source[:50000] + "\n...(truncated)")
            elif extract_type == "title":
                return format_tool_result(self.name, f"Page Title: {driver.title}")
            else:
                body_text = driver.find_element(By.TAG_NAME, "body").text
                return format_tool_result(self.name, f"Page Text (first 5000 chars):\n{body_text[:5000]}")
        except Exception as e:
            return format_tool_result(self.name, f"Extraction failed: {e}", success=False)


class CloseBrowserTool(BaseTool):
    """Close the browser session."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "browser_close"

    @property
    def description(self) -> str:
        return "Close the automated browser session."

    def execute(self, args: Dict[str, Any]) -> str:
        SeleniumBrowser.close()
        return format_tool_result(self.name, "Browser session closed.")
