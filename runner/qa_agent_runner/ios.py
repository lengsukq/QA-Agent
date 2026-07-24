"""iOS Simulator platform driver using xcrun simctl + fb-idb CLI.

Verified commands (idb 1.1.8):
  idb ui tap X Y              -- tap at coordinates
  idb ui text "..."           -- type text (NOT 'type')
  idb ui swipe X1 Y1 X2 Y2   -- swipe between coordinates (NOT direction names)
  idb ui button HOME/LOCK     -- hardware buttons
  idb ui key-sequence "..."   -- key input
  idb ui describe-all         -- accessibility tree dump
  xcrun simctl io UDID screenshot PATH
  xcrun simctl launch UDID BUNDLE_ID
  xcrun simctl terminate UDID BUNDLE_ID
  xcrun simctl install UDID APP_PATH
"""

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any


# Default screen dimensions for iPhone Air (logical points, verified via describe-all)
_DEFAULT_WIDTH = 420
_DEFAULT_HEIGHT = 912


class IosDriver:
    """Executes UI commands on iOS Simulator via xcrun simctl and idb."""

    def __init__(self, screenshot_dir: Path, env_vars: dict[str, str], device_udid: str | None = None) -> None:
        self._screenshot_dir = screenshot_dir
        self._env = {**os.environ, **env_vars}
        self._udid = device_udid or self._find_booted_device()
        if not self._udid:
            raise RuntimeError("No booted iOS Simulator found. Boot one first or pass deviceUdid.")
        self._ensure_idb_connected()

    def close(self) -> None:
        pass  # Simulator stays running; we don't own its lifecycle.

    # --- Infrastructure ---

    def _find_booted_device(self) -> str | None:
        result = subprocess.run(
            ["xcrun", "simctl", "list", "devices", "--json"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        for runtime_devices in data.get("devices", {}).values():
            for device in runtime_devices:
                if device.get("state") == "Booted":
                    return device["udid"]
        return None

    def _ensure_idb_connected(self) -> None:
        """Ensure idb companion is connected to the device."""
        # Try connecting; ignore errors if already connected
        subprocess.run(
            ["idb", "connect", self._udid],
            capture_output=True, text=True, check=False, env=self._env,
        )

    def _simctl(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["xcrun", "simctl", *args],
            capture_output=True, text=True, check=False, env=self._env,
        )

    def _idb(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["idb", *args, "--udid", self._udid],
            capture_output=True, text=True, check=False, env=self._env,
        )

    def _take_screenshot(self, step_id: str) -> str:
        screenshot_name = f"{step_id}.png"
        screenshot_path = self._screenshot_dir / screenshot_name
        # Retry: the simulator framebuffer can be briefly busy right after an app
        # launch/transition, causing a transient screenshot failure.
        last_err = ""
        for attempt in range(3):
            result = self._simctl("io", self._udid, "screenshot", str(screenshot_path))
            if result.returncode == 0:
                return screenshot_name
            last_err = result.stderr.strip()
            time.sleep(1)
        raise RuntimeError(f"Screenshot failed: {last_err}")

    def execute(self, cmd: str, params: dict[str, Any], step_id: str) -> dict[str, Any]:
        handler = getattr(self, f"_cmd_{cmd.replace('-', '_')}", None)
        if handler is None:
            return {"ok": False, "error": f"Unknown iOS command: {cmd}", "stepId": step_id}
        try:
            actual = handler(params)
        except Exception as exc:
            # Still take screenshot on failure for evidence
            screenshot_name = self._take_screenshot(step_id)
            return {"ok": False, "error": str(exc), "screenshot": screenshot_name, "stepId": step_id}
        screenshot_name = self._take_screenshot(step_id)
        return {"ok": True, "screenshot": screenshot_name, "actual": actual, "stepId": step_id}

    # --- Command implementations ---

    def _cmd_launch(self, params: dict[str, Any]) -> str:
        bundle_id = params.get("bundleId") or params.get("url", "")
        if not bundle_id:
            raise ValueError("launch requires a bundleId.")
        result = self._simctl("launch", self._udid, bundle_id)
        if result.returncode != 0:
            raise RuntimeError(f"Failed to launch {bundle_id}: {result.stderr.strip()}")
        time.sleep(3)  # Wait for app to fully start and framebuffer to settle
        return f"Launched {bundle_id}"

    def _cmd_terminate(self, params: dict[str, Any]) -> str:
        bundle_id = params.get("bundleId", "")
        if not bundle_id:
            raise ValueError("terminate requires a bundleId.")
        self._simctl("terminate", self._udid, bundle_id)
        return f"Terminated {bundle_id}"

    def _cmd_install(self, params: dict[str, Any]) -> str:
        app_path = params.get("appPath", "")
        if not app_path:
            raise ValueError("install requires an appPath.")
        result = self._simctl("install", self._udid, app_path)
        if result.returncode != 0:
            raise RuntimeError(f"Failed to install {app_path}: {result.stderr.strip()}")
        return f"Installed {app_path}"

    def _cmd_tap(self, params: dict[str, Any]) -> str:
        """Tap at coordinates. Params: x, y (integers) or locator with coordinate strategy."""
        x = params.get("x")
        y = params.get("y")

        if x is None or y is None:
            locator = params.get("locator", {})
            value = locator.get("value", "")
            if "," in value:
                parts = value.split(",", 1)
                x, y = int(parts[0].strip()), int(parts[1].strip())
            else:
                raise ValueError("iOS tap requires x,y coordinates.")

        result = self._idb("ui", "tap", str(x), str(y))
        if result.returncode != 0:
            raise RuntimeError(f"Tap failed: {result.stderr.strip()}")
        time.sleep(0.5)  # Brief wait for UI to respond
        return f"Tapped ({x}, {y})"

    def _cmd_type_text(self, params: dict[str, Any]) -> str:
        """Type text using idb ui text (NOT 'type')."""
        input_ref = params.get("inputRef")
        text = params.get("text") or params.get("value", "")
        if input_ref:
            key = input_ref.removeprefix("env:")
            text = self._env.get(key, "")
            if not text:
                raise ValueError(f"Environment variable not found: {key}")
        if not text:
            raise ValueError("type_text requires text or inputRef.")
        result = self._idb("ui", "text", text)
        if result.returncode != 0:
            raise RuntimeError(f"Text input failed: {result.stderr.strip()}")
        return "Typed text"

    def _cmd_fill(self, params: dict[str, Any]) -> str:
        """Fill = tap field (if locator provided) then type text."""
        locator = params.get("locator")
        if locator:
            self._cmd_tap(params)
            time.sleep(0.3)
        return self._cmd_type_text(params)

    def _cmd_swipe(self, params: dict[str, Any]) -> str:
        """Swipe using coordinates. Supports direction shorthand or explicit coords.

        Params:
          direction: up/down/left/right (uses screen center as reference)
          OR x1, y1, x2, y2: explicit coordinates
        """
        x1 = params.get("x1")
        y1 = params.get("y1")
        x2 = params.get("x2")
        y2 = params.get("y2")

        if x1 is None:
            # Convert direction to coordinates using screen center
            direction = params.get("direction", "up")
            cx, cy = _DEFAULT_WIDTH // 2, _DEFAULT_HEIGHT // 2
            distance = 300

            if direction == "up":
                x1, y1, x2, y2 = cx, cy + distance // 2, cx, cy - distance // 2
            elif direction == "down":
                x1, y1, x2, y2 = cx, cy - distance // 2, cx, cy + distance // 2
            elif direction == "left":
                x1, y1, x2, y2 = cx + distance // 2, cy, cx - distance // 2, cy
            elif direction == "right":
                x1, y1, x2, y2 = cx - distance // 2, cy, cx + distance // 2, cy
            else:
                raise ValueError(f"Unknown swipe direction: {direction}")

        result = self._idb("ui", "swipe", str(x1), str(y1), str(x2), str(y2))
        if result.returncode != 0:
            raise RuntimeError(f"Swipe failed: {result.stderr.strip()}")
        time.sleep(0.5)
        return f"Swiped ({x1},{y1}) → ({x2},{y2})"

    def _cmd_back(self, params: dict[str, Any]) -> str:
        """Navigate back via left-edge swipe."""
        # Swipe from left edge to right (iOS back gesture)
        result = self._idb("ui", "swipe", "5", str(_DEFAULT_HEIGHT // 2), str(_DEFAULT_WIDTH // 2), str(_DEFAULT_HEIGHT // 2))
        if result.returncode != 0:
            raise RuntimeError(f"Back gesture failed: {result.stderr.strip()}")
        time.sleep(0.5)
        return "Navigated back (edge swipe)"

    def _cmd_home(self, params: dict[str, Any]) -> str:
        """Press home button via idb ui button."""
        result = self._idb("ui", "button", "HOME")
        if result.returncode != 0:
            raise RuntimeError(f"Home button failed: {result.stderr.strip()}")
        time.sleep(0.5)
        return "Pressed home"

    def _cmd_assert_visible(self, params: dict[str, Any]) -> str:
        """Check element visibility via accessibility tree dump."""
        locator = params.get("locator", {})
        value = locator.get("value", "")
        if not value:
            raise ValueError("assert_visible requires a locator value (accessibility label).")
        result = self._idb("ui", "describe-all")
        if result.returncode != 0:
            raise RuntimeError(f"describe-all failed: {result.stderr.strip()}")
        # Parse JSON and search for matching AXLabel
        try:
            elements = json.loads(result.stdout)
            for el in elements:
                label = el.get("AXLabel") or ""
                if value.lower() in label.lower():
                    frame = el.get("frame", {})
                    return f"Element '{label}' found at ({frame.get('x', 0)}, {frame.get('y', 0)}) size {frame.get('width', 0)}x{frame.get('height', 0)}"
        except json.JSONDecodeError:
            pass
        raise AssertionError(f"Element '{value}' not found in accessibility tree")

    def _cmd_screenshot(self, params: dict[str, Any]) -> str:
        """Explicit screenshot (the execute() wrapper already takes one)."""
        name = params.get("name", "explicit")
        return f"Screenshot '{name}' captured"

    def _cmd_wait(self, params: dict[str, Any]) -> str:
        ms = params.get("ms", 1000)
        time.sleep(ms / 1000.0)
        return f"Waited {ms}ms"

    def _cmd_key(self, params: dict[str, Any]) -> str:
        """Press a hardware/keyboard key by keycode."""
        keycode = params.get("keycode") or params.get("key", "")
        if not keycode:
            raise ValueError("key requires a keycode (e.g. 4=backspace, 3=home).")
        result = self._idb("ui", "key", str(keycode))
        if result.returncode != 0:
            raise RuntimeError(f"Key press failed: {result.stderr.strip()}")
        return f"Pressed key {keycode}"

    def _cmd_describe(self, params: dict[str, Any]) -> str:
        """Dump accessibility tree for AI to understand current screen."""
        result = self._idb("ui", "describe-all")
        if result.returncode != 0:
            raise RuntimeError(f"describe-all failed: {result.stderr.strip()}")
        # Parse and format as readable summary
        try:
            elements = json.loads(result.stdout)
            lines = []
            for el in elements:
                role = el.get("role_description", el.get("type", "?"))
                label = el.get("AXLabel") or ""
                value = el.get("AXValue") or ""
                frame = el.get("frame", {})
                x = frame.get("x", 0)
                y = frame.get("y", 0)
                w = frame.get("width", 0)
                h = frame.get("height", 0)
                cx, cy = int(x + w / 2), int(y + h / 2)
                desc = f"[{role}]"
                if label:
                    desc += f" \"{label}\""
                if value:
                    desc += f" value=\"{value}\""
                desc += f" center=({cx},{cy})"
                lines.append(desc)
            output = "\n".join(lines)
            if len(output) > 8000:
                output = output[:8000] + "\n... (truncated)"
            return output
        except json.JSONDecodeError:
            output = result.stdout
            if len(output) > 5000:
                output = output[:5000] + "\n... (truncated)"
            return output
