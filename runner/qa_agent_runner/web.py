"""Web platform driver using Playwright (Chromium)."""

import os
from pathlib import Path
from typing import Any


class WebDriver:
    """Executes UI commands via Playwright sync API."""

    def __init__(self, screenshot_dir: Path, env_vars: dict[str, str]) -> None:
        from playwright.sync_api import sync_playwright

        self._screenshot_dir = screenshot_dir
        self._env = {**os.environ, **env_vars}
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True)
        self._page = self._browser.new_page()
        self._page.set_default_timeout(30_000)

    def close(self) -> None:
        try:
            self._browser.close()
        finally:
            self._pw.stop()

    def execute(self, cmd: str, params: dict[str, Any], step_id: str) -> dict[str, Any]:
        handler = getattr(self, f"_cmd_{cmd.replace('-', '_')}", None)
        screenshot_name = f"{step_id}.png"
        screenshot_path = self._screenshot_dir / screenshot_name
        if handler is None:
            self._safe_screenshot(screenshot_path)
            return {"ok": False, "error": f"Unknown web command: {cmd}", "screenshot": screenshot_name, "stepId": step_id}
        try:
            actual = handler(params)
        except Exception as exc:
            # Still capture a screenshot on failure for evidence
            self._safe_screenshot(screenshot_path)
            return {"ok": False, "error": str(exc), "screenshot": screenshot_name, "stepId": step_id}
        self._safe_screenshot(screenshot_path)
        return {"ok": True, "screenshot": screenshot_name, "actual": actual, "stepId": step_id}

    def _safe_screenshot(self, path: Path) -> None:
        try:
            self._page.screenshot(path=str(path))
        except Exception:
            pass

    # --- Locator resolution ---

    def _resolve(self, locator: dict[str, str] | None):
        """Resolve a locator dict to a Playwright Locator."""
        if not locator:
            raise ValueError("Command requires a locator.")
        strategy = locator.get("strategy", "css")
        value = locator.get("value", "")
        page = self._page

        if strategy == "css":
            return page.locator(value)
        elif strategy == "xpath":
            return page.locator(f"xpath={value}")
        elif strategy == "text":
            return page.get_by_text(value)
        elif strategy == "test-id":
            return page.get_by_test_id(value)
        elif strategy == "role":
            # Format: "role=button:Name" → role="button", name="Name"
            if ":" in value:
                role, name = value.split(":", 1)
                return page.get_by_role(role, name=name)
            return page.get_by_role(value)
        elif strategy == "label":
            return page.get_by_label(value)
        elif strategy == "placeholder":
            return page.get_by_placeholder(value)
        elif strategy == "accessibility":
            return page.get_by_role("generic", name=value)
        else:
            return page.locator(value)

    def _resolve_input(self, input_ref: str | None, direct_value: str | None = None) -> str:
        """Resolve input value from env reference or direct value."""
        if direct_value:
            return direct_value
        if not input_ref:
            raise ValueError("fill requires --input-ref or --value.")
        # Strip optional "env:" prefix
        key = input_ref.removeprefix("env:")
        value = self._env.get(key)
        if value is None:
            raise ValueError(f"Environment variable not found: {key}")
        return value

    # --- Command implementations ---

    def _cmd_navigate(self, params: dict[str, Any]) -> str:
        url = params.get("url")
        if not url:
            raise ValueError("navigate requires a url.")
        timeout = params.get("timeout", 30_000)
        self._page.goto(url, timeout=timeout, wait_until="load")
        return f"Navigated to {url}"

    def _cmd_click(self, params: dict[str, Any]) -> str:
        loc = self._resolve(params.get("locator"))
        loc.click(timeout=params.get("timeout", 30_000))
        return f"Clicked {params.get('locator', {}).get('value', 'element')}"

    def _cmd_fill(self, params: dict[str, Any]) -> str:
        loc = self._resolve(params.get("locator"))
        value = self._resolve_input(params.get("inputRef"), params.get("value"))
        loc.fill(value, timeout=params.get("timeout", 30_000))
        return f"Filled {params.get('locator', {}).get('value', 'field')}"

    def _cmd_select(self, params: dict[str, Any]) -> str:
        loc = self._resolve(params.get("locator"))
        value = params.get("value", "")
        loc.select_option(value, timeout=params.get("timeout", 30_000))
        return f"Selected '{value}' in {params.get('locator', {}).get('value', 'select')}"

    def _cmd_assert_text(self, params: dict[str, Any]) -> str:
        loc = self._resolve(params.get("locator"))
        expected = params.get("expected", "")
        actual_text = loc.inner_text(timeout=params.get("timeout", 30_000))
        if expected.lower() not in actual_text.lower():
            raise AssertionError(f"Expected text '{expected}' not found in '{actual_text}'")
        return actual_text

    def _cmd_assert_visible(self, params: dict[str, Any]) -> str:
        loc = self._resolve(params.get("locator"))
        loc.wait_for(state="visible", timeout=params.get("timeout", 30_000))
        return f"{params.get('locator', {}).get('value', 'element')} is visible"

    def _cmd_wait(self, params: dict[str, Any]) -> str:
        ms = params.get("ms")
        locator = params.get("locator")
        if locator:
            loc = self._resolve(locator)
            loc.wait_for(state="visible", timeout=params.get("timeout", 30_000))
            return f"Waited for {locator.get('value', 'element')}"
        elif ms:
            self._page.wait_for_timeout(ms)
            return f"Waited {ms}ms"
        else:
            self._page.wait_for_timeout(1000)
            return "Waited 1000ms (default)"

    def _cmd_screenshot(self, params: dict[str, Any]) -> str:
        return "Screenshot captured"

    def _cmd_scroll(self, params: dict[str, Any]) -> str:
        direction = params.get("direction", "down")
        locator = params.get("locator")
        if locator:
            loc = self._resolve(locator)
            loc.scroll_into_view_if_needed(timeout=params.get("timeout", 30_000))
            return f"Scrolled to {locator.get('value', 'element')}"
        delta = 300 if direction == "down" else -300
        self._page.mouse.wheel(0, delta)
        return f"Scrolled {direction}"

    def _cmd_hover(self, params: dict[str, Any]) -> str:
        loc = self._resolve(params.get("locator"))
        loc.hover(timeout=params.get("timeout", 30_000))
        return f"Hovered {params.get('locator', {}).get('value', 'element')}"

    def _cmd_press(self, params: dict[str, Any]) -> str:
        key = params.get("key", "Enter")
        self._page.keyboard.press(key)
        return f"Pressed {key}"
