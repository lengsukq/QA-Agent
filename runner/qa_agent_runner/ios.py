"""iOS Simulator driver built on xcrun simctl and fb-idb.

The iOS adapter deliberately observes the current accessibility tree before
performing semantic actions. Coordinates remain available as an explicit
fallback, but are never inferred from a fixed device size.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable


class IosDriver:
    """Execute UI commands against one explicitly selected iOS Simulator."""

    def __init__(self, screenshot_dir: Path, env_vars: dict[str, str], device_udid: str | None = None) -> None:
        self._screenshot_dir = screenshot_dir
        self._screenshot_dir.mkdir(parents=True, exist_ok=True)
        self._env = {**os.environ, **env_vars}
        self._udid = device_udid or self._find_booted_device()
        if not self._udid:
            raise RuntimeError("No booted iOS Simulator found. Boot one first or pass deviceUdid.")
        self._idb_bin = self._resolve_binary("QA_AGENT_IDB", "idb")
        self._companion = self._resolve_binary("QA_AGENT_IDB_COMPANION", "idb_companion", required=False)
        self._ensure_idb_connected()

    def close(self) -> None:
        # The Runner does not own the simulator lifecycle.
        return None

    # --- Infrastructure -------------------------------------------------

    def _resolve_binary(self, env_name: str, command: str, required: bool = True) -> str | None:
        configured = self._env.get(env_name, "").strip()
        path = configured or shutil.which(command)
        if required and not path:
            raise RuntimeError(f"{command} was not found. Install it or set {env_name}.")
        return path

    def _find_booted_device(self) -> str | None:
        result = subprocess.run(
            ["xcrun", "simctl", "list", "devices", "--json"],
            capture_output=True,
            text=True,
            check=False,
            env=self._env,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Unable to list iOS Simulators: {result.stderr.strip()}")
        data = json.loads(result.stdout)
        booted = [
            (device.get("name", "unknown"), device.get("udid"))
            for devices in data.get("devices", {}).values()
            for device in devices
            if device.get("state") == "Booted" and device.get("udid")
        ]
        if len(booted) > 1:
            names = ", ".join(f"{name} ({udid})" for name, udid in booted)
            raise RuntimeError(f"Multiple booted iOS Simulators found; pass deviceUdid explicitly: {names}")
        return booted[0][1] if booted else None

    def _companion_prefix(self) -> list[str]:
        return ["--companion-path", self._companion] if self._companion else []

    def _ensure_idb_connected(self) -> None:
        # `connect` takes the UDID as a positional argument, unlike UI commands.
        result = subprocess.run(
            [self._idb_bin, *self._companion_prefix(), "connect", self._udid],
            capture_output=True,
            text=True,
            check=False,
            env=self._env,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Unable to connect idb to simulator {self._udid}: {result.stderr.strip()}")

    def _simctl(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["xcrun", "simctl", *args],
            capture_output=True,
            text=True,
            check=False,
            env=self._env,
        )

    def _idb(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self._idb_bin, *self._companion_prefix(), *args, "--udid", self._udid],
            capture_output=True,
            text=True,
            check=False,
            env=self._env,
        )

    def _take_screenshot(self, step_id: str) -> str:
        screenshot_name = f"{step_id}.png"
        screenshot_path = self._screenshot_dir / screenshot_name
        last_err = ""
        for _ in range(3):
            result = self._simctl("io", self._udid, "screenshot", str(screenshot_path))
            if result.returncode == 0 and screenshot_path.exists():
                return screenshot_name
            last_err = result.stderr.strip() or result.stdout.strip()
            time.sleep(0.2)
        raise RuntimeError(f"Screenshot failed for simulator {self._udid}: {last_err}")

    # --- Accessibility tree and waiting --------------------------------

    def _parse_tree(self, output: str) -> list[dict[str, Any]]:
        try:
            decoded = json.loads(output)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"idb accessibility output was not JSON: {exc}") from exc
        if isinstance(decoded, list):
            return [item for item in decoded if isinstance(item, dict)]
        if isinstance(decoded, dict):
            for key in ("elements", "items", "children", "tree"):
                value = decoded.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
        raise RuntimeError("idb accessibility output did not contain an element list.")

    def _read_tree(self) -> list[dict[str, Any]]:
        result = self._idb("ui", "describe-all", "--json")
        if result.returncode != 0:
            # Older idb versions emit JSON without accepting --json.
            fallback = self._idb("ui", "describe-all")
            if fallback.returncode != 0:
                detail = fallback.stderr.strip() or result.stderr.strip()
                raise RuntimeError(f"describe-all failed for simulator {self._udid}: {detail}")
            result = fallback
        return self._parse_tree(result.stdout)

    @staticmethod
    def _tree_signature(tree: list[dict[str, Any]]) -> str:
        return json.dumps(tree, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    def _wait_for_tree(self, predicate, description: str, timeout: float = 30.0) -> Any:
        deadline = time.monotonic() + timeout
        last_error = ""
        while time.monotonic() < deadline:
            try:
                tree = self._read_tree()
                value = predicate(tree)
                if value is not None and value is not False:
                    return value
            except Exception as exc:  # The tree may be unavailable during a transition.
                last_error = str(exc)
            time.sleep(0.25)
        suffix = f" Last error: {last_error}" if last_error else ""
        raise TimeoutError(f"Timed out waiting for {description} on simulator {self._udid}.{suffix}")

    def _wait_for_settle(self, timeout: float = 5.0) -> list[dict[str, Any]]:
        """Wait until two consecutive accessibility snapshots are identical."""
        previous: str | None = None

        def stable(tree: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
            nonlocal previous
            signature = self._tree_signature(tree)
            if signature == previous:
                return tree
            previous = signature
            return None

        return self._wait_for_tree(stable, "UI accessibility tree to settle", timeout)

    def _screen_bounds(self, tree: list[dict[str, Any]]) -> tuple[int, int]:
        right = 0.0
        bottom = 0.0
        for element in tree:
            frame = element.get("frame") or {}
            try:
                right = max(right, float(frame.get("x", 0)) + float(frame.get("width", 0)))
                bottom = max(bottom, float(frame.get("y", 0)) + float(frame.get("height", 0)))
            except (TypeError, ValueError):
                continue
        if right <= 0 or bottom <= 0:
            raise RuntimeError(f"Could not determine simulator screen bounds from accessibility tree on {self._udid}.")
        return round(right), round(bottom)

    # --- Locator resolution ---------------------------------------------

    @staticmethod
    def _text(value: Any) -> str:
        return "" if value is None else str(value)

    @staticmethod
    def _frame(element: dict[str, Any]) -> dict[str, float]:
        frame = element.get("frame") or {}
        return {
            "x": float(frame.get("x", 0) or 0),
            "y": float(frame.get("y", 0) or 0),
            "width": float(frame.get("width", 0) or 0),
            "height": float(frame.get("height", 0) or 0),
        }

    @classmethod
    def _is_visible(cls, element: dict[str, Any]) -> bool:
        frame = cls._frame(element)
        return frame["width"] > 0 and frame["height"] > 0

    @classmethod
    def _matches_text(cls, element: dict[str, Any], value: str, exact: bool = True) -> bool:
        candidates = [cls._text(element.get("AXLabel")), cls._text(element.get("AXValue"))]
        normalized = value.casefold()
        return any(
            candidate.casefold() == normalized if exact else normalized in candidate.casefold()
            for candidate in candidates
            if candidate
        )

    def _resolve_element(self, locator: dict[str, Any] | None, exact: bool = True, tree: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        if not locator:
            raise ValueError("iOS command requires a locator or explicit coordinates.")
        strategy = str(locator.get("strategy", "accessibility"))
        value = self._text(locator.get("value"))
        if strategy == "coordinate":
            parts = value.split(",", 1)
            if len(parts) != 2:
                raise ValueError("Coordinate locator must be formatted as coordinate=x,y.")
            x, y = int(parts[0].strip()), int(parts[1].strip())
            return {"frame": {"x": x - 1, "y": y - 1, "width": 2, "height": 2}}, {"strategy": "coordinate", "value": f"{x},{y}"}

        tree = tree if tree is not None else self._read_tree()
        matches: list[dict[str, Any]] = []
        for element in tree:
            if not self._is_visible(element):
                continue
            element_type = self._text(element.get("type") or element.get("role") or element.get("role_description"))
            label = self._text(element.get("AXLabel"))
            if strategy in ("accessibility", "label", "text"):
                # Product cards and native controls commonly expose a
                # compound AXLabel such as "Bvlgari\nAviator Sunglasses...".
                # Prefer exact matching, then allow a semantic contains match
                # when exact matching found nothing; ambiguity is still an
                # error below.
                if self._matches_text(element, value, exact) or (exact and self._matches_text(element, value, False)):
                    matches.append(element)
            elif strategy == "value":
                if self._text(element.get("AXValue")) == value:
                    matches.append(element)
            elif strategy in ("role", "type"):
                role = value
                name: str | None = None
                if strategy == "role" and ":" in value:
                    role, name = value.split(":", 1)
                if role.casefold() not in element_type.casefold():
                    continue
                # Native AX labels often append context such as "Tab 5 of 5"
                # to the visible name. Role locators therefore use the name
                # as a semantic contains match while still rejecting ambiguity.
                if name is None or self._matches_text(element, name, False):
                    matches.append(element)
            else:
                raise ValueError(f"Unsupported iOS locator strategy: {strategy}")

        if not matches:
            raise AssertionError(f"iOS element not found: {strategy}={value!r}")
        if len(matches) > 1:
            descriptions = [self._element_description(item) for item in matches[:5]]
            raise AssertionError(f"iOS locator is ambiguous: {strategy}={value!r}; matches={descriptions}")
        return matches[0], {"strategy": strategy, "value": value}

    @classmethod
    def _element_description(cls, element: dict[str, Any]) -> str:
        frame = cls._frame(element)
        role = cls._text(element.get("type") or element.get("role") or element.get("role_description"))
        label = cls._text(element.get("AXLabel"))
        value = cls._text(element.get("AXValue"))
        return f"{role} label={label!r} value={value!r} frame={frame}"

    @classmethod
    def _center(cls, element: dict[str, Any]) -> tuple[int, int]:
        frame = cls._frame(element)
        return round(frame["x"] + frame["width"] / 2), round(frame["y"] + frame["height"] / 2)

    # --- HID and text input ---------------------------------------------

    async def _hid(self, keycodes: Iterable[int]) -> None:
        if not self._companion:
            raise RuntimeError("Raw HID input requires idb_companion. Set QA_AGENT_IDB_COMPANION or install idb_companion.")
        try:
            from idb.common.hid import iterator_to_async_iterator, key_press_to_events
            from idb.grpc.management import ClientManager
        except ImportError as exc:
            raise RuntimeError("Raw HID input requires fb-idb in the Runner Python environment.") from exc

        manager = ClientManager(companion_path=self._companion)
        async with manager.from_udid(self._udid) as client:
            events = []
            for keycode in keycodes:
                events.extend(key_press_to_events(keycode))
            await client.hid(iterator_to_async_iterator(events))

    def _send_hid(self, keycodes: Iterable[int]) -> None:
        asyncio.run(self._hid(keycodes))

    def _clear_focused_text(self, max_chars: int = 250, reference: dict[str, Any] | None = None) -> None:
        if max_chars <= 0:
            raise ValueError("maxChars must be greater than zero.")
        # USB HID: Right Arrow = 79, Backspace = 42.
        self._send_hid([79] * max_chars + [42] * max_chars)
        tree = self._read_tree()
        focused = [
            item for item in tree
            if item.get("AXFocused") is True or item.get("focused") is True or item.get("isFocused") is True
        ]
        if focused and any(self._text(item.get("AXValue")) for item in focused):
            raise AssertionError(f"Focused iOS text field was not cleared: {[self._element_description(item) for item in focused]}")
        if reference:
            reference_frame = self._frame(reference)
            nearby = []
            for item in tree:
                frame = self._frame(item)
                if abs(frame["x"] - reference_frame["x"]) <= 3 and abs(frame["y"] - reference_frame["y"]) <= 3:
                    nearby.append(item)
            if nearby and any(self._text(item.get("AXValue")) for item in nearby):
                raise AssertionError(f"iOS text field was not cleared: {[self._element_description(item) for item in nearby]}")

    # --- Command implementations ---------------------------------------

    def execute(self, cmd: str, params: dict[str, Any], step_id: str) -> dict[str, Any]:
        handler = getattr(self, f"_cmd_{cmd.replace('-', '_')}", None)
        if handler is None:
            try:
                screenshot_name = self._take_screenshot(step_id)
            except Exception as screenshot_exc:
                return {"ok": False, "error": f"Unknown iOS command: {cmd}; screenshot failed: {screenshot_exc}", "stepId": step_id, "udid": self._udid}
            return {"ok": False, "error": f"Unknown iOS command: {cmd}", "screenshot": screenshot_name, "stepId": step_id, "udid": self._udid}

        try:
            actual = handler(params)
        except Exception as exc:
            try:
                screenshot_name = self._take_screenshot(step_id)
                return {"ok": False, "error": str(exc), "screenshot": screenshot_name, "stepId": step_id, "udid": self._udid}
            except Exception as screenshot_exc:
                return {"ok": False, "error": f"{exc}; failure screenshot also failed: {screenshot_exc}", "stepId": step_id, "udid": self._udid}

        try:
            screenshot_name = self._take_screenshot(step_id)
        except Exception as exc:
            return {"ok": False, "error": f"Action succeeded but screenshot failed: {exc}", "actual": actual, "stepId": step_id, "udid": self._udid}
        response: dict[str, Any] = {"ok": True, "screenshot": screenshot_name, "actual": actual, "stepId": step_id, "udid": self._udid}
        if isinstance(actual, dict) and actual.get("resolvedLocator"):
            response["resolvedLocator"] = actual["resolvedLocator"]
        return response

    def _cmd_launch(self, params: dict[str, Any]) -> dict[str, Any]:
        bundle_id = params.get("bundleId") or params.get("url", "")
        if not bundle_id:
            raise ValueError("launch requires a bundleId.")
        result = self._simctl("launch", self._udid, str(bundle_id))
        if result.returncode != 0:
            raise RuntimeError(f"Failed to launch {bundle_id} on {self._udid}: {result.stderr.strip()}")
        tree = self._wait_for_tree(lambda value: value if value else None, f"{bundle_id} accessibility tree", float(params.get("timeout", 30)))
        return {"action": "launch", "bundleId": bundle_id, "elementCount": len(tree)}

    def _cmd_terminate(self, params: dict[str, Any]) -> dict[str, Any]:
        bundle_id = params.get("bundleId", "")
        if not bundle_id:
            raise ValueError("terminate requires a bundleId.")
        result = self._simctl("terminate", self._udid, str(bundle_id))
        if result.returncode != 0 and "was not running" not in result.stderr.lower():
            raise RuntimeError(f"Failed to terminate {bundle_id}: {result.stderr.strip()}")
        return {"action": "terminate", "bundleId": bundle_id}

    def _cmd_install(self, params: dict[str, Any]) -> dict[str, Any]:
        app_path = params.get("appPath", "")
        if not app_path:
            raise ValueError("install requires an appPath.")
        result = self._simctl("install", self._udid, str(app_path))
        if result.returncode != 0:
            raise RuntimeError(f"Failed to install {app_path}: {result.stderr.strip()}")
        return {"action": "install", "appPath": app_path}

    def _cmd_tap(self, params: dict[str, Any]) -> dict[str, Any]:
        x = params.get("x")
        y = params.get("y")
        resolved: dict[str, Any]
        if x is None or y is None:
            element, resolved = self._resolve_element(params.get("locator"), exact=True)
            x, y = self._center(element)
        else:
            x, y = int(x), int(y)
            resolved = {"strategy": "coordinate", "value": f"{x},{y}"}
        result = self._idb("ui", "tap", str(x), str(y))
        if result.returncode != 0:
            raise RuntimeError(f"Tap failed at ({x}, {y}) on {self._udid}: {result.stderr.strip()}")
        self._wait_for_settle()
        return {"action": "tap", "resolvedLocator": resolved, "point": {"x": x, "y": y}}

    def _cmd_type_text(self, params: dict[str, Any]) -> dict[str, Any]:
        input_ref = params.get("inputRef")
        text = params.get("text") or params.get("value", "")
        if input_ref:
            key = str(input_ref).removeprefix("env:")
            text = self._env.get(key, "")
            if not text:
                raise ValueError(f"Environment variable not found: {key}")
        if not text:
            raise ValueError("type_text requires text or inputRef.")
        result = self._idb("ui", "text", str(text))
        if result.returncode != 0:
            raise RuntimeError(f"Text input failed on {self._udid}: {result.stderr.strip()}")
        self._wait_for_settle()
        return {"action": "type-text", "inputRef": input_ref, "length": len(str(text))}

    def _cmd_clear(self, params: dict[str, Any]) -> dict[str, Any]:
        locator = params.get("locator")
        resolved = None
        if locator:
            element, resolved = self._resolve_element(locator, exact=True)
            x, y = self._center(element)
            result = self._idb("ui", "tap", str(x), str(y))
            if result.returncode != 0:
                raise RuntimeError(f"Could not focus field at ({x}, {y}): {result.stderr.strip()}")
        max_chars = int(params.get("maxChars", 250))
        self._clear_focused_text(max_chars, element if locator else None)
        self._wait_for_settle()
        return {"action": "clear", "resolvedLocator": resolved, "maxChars": max_chars}

    def _cmd_fill(self, params: dict[str, Any]) -> dict[str, Any]:
        locator = params.get("locator")
        resolved = None
        if locator:
            element, resolved = self._resolve_element(locator, exact=True)
            x, y = self._center(element)
            result = self._idb("ui", "tap", str(x), str(y))
            if result.returncode != 0:
                raise RuntimeError(f"Could not focus field at ({x}, {y}): {result.stderr.strip()}")
        self._clear_focused_text(int(params.get("maxChars", 250)), element if locator else None)
        typed = self._cmd_type_text(params)
        typed["action"] = "fill"
        typed["resolvedLocator"] = resolved
        return typed

    def _cmd_swipe(self, params: dict[str, Any]) -> dict[str, Any]:
        tree = self._read_tree()
        width, height = self._screen_bounds(tree)
        x1, y1, x2, y2 = (params.get(key) for key in ("x1", "y1", "x2", "y2"))
        if any(value is None for value in (x1, y1, x2, y2)):
            direction = str(params.get("direction", "up")).lower()
            margin_x, margin_y = max(10, round(width * 0.08)), max(10, round(height * 0.12))
            cx, cy = width // 2, height // 2
            if direction == "up":
                x1, y1, x2, y2 = cx, height - margin_y, cx, margin_y
            elif direction == "down":
                x1, y1, x2, y2 = cx, margin_y, cx, height - margin_y
            elif direction == "left":
                x1, y1, x2, y2 = width - margin_x, cy, margin_x, cy
            elif direction == "right":
                x1, y1, x2, y2 = margin_x, cy, width - margin_x, cy
            else:
                raise ValueError(f"Unknown swipe direction: {direction}")
        result = self._idb("ui", "swipe", str(int(x1)), str(int(y1)), str(int(x2)), str(int(y2)))
        if result.returncode != 0:
            raise RuntimeError(f"Swipe failed on {self._udid}: {result.stderr.strip()}")
        self._wait_for_settle()
        return {"action": "swipe", "from": {"x": int(x1), "y": int(y1)}, "to": {"x": int(x2), "y": int(y2)}}

    def _cmd_scroll(self, params: dict[str, Any]) -> dict[str, Any]:
        """Scroll is the semantic alias used by the unified command surface."""
        result = self._cmd_swipe(params)
        result["action"] = "scroll"
        return result

    def _cmd_back(self, params: dict[str, Any]) -> dict[str, Any]:
        tree = self._read_tree()
        width, height = self._screen_bounds(tree)
        result = self._idb("ui", "swipe", "5", str(height // 2), str(width // 2), str(height // 2))
        if result.returncode != 0:
            raise RuntimeError(f"Back gesture failed on {self._udid}: {result.stderr.strip()}")
        self._wait_for_settle()
        return {"action": "back", "gesture": "edge-swipe", "screen": {"width": width, "height": height}}

    def _cmd_home(self, params: dict[str, Any]) -> dict[str, Any]:
        result = self._idb("ui", "button", "HOME")
        if result.returncode != 0:
            raise RuntimeError(f"Home button failed on {self._udid}: {result.stderr.strip()}")
        return {"action": "home"}

    def _cmd_assert_visible(self, params: dict[str, Any]) -> dict[str, Any]:
        element, resolved = self._resolve_element(params.get("locator"), exact=bool(params.get("exact", True)))
        return {"action": "assert-visible", "resolvedLocator": resolved, "element": element}

    def _cmd_assert_text(self, params: dict[str, Any]) -> dict[str, Any]:
        expected = self._text(params.get("expected"))
        if not expected:
            raise ValueError("assert-text requires expected text.")
        element, resolved = self._resolve_element(params.get("locator"), exact=bool(params.get("exact", True)))
        actual = self._text(element.get("AXValue")) or self._text(element.get("AXLabel"))
        if expected.casefold() not in actual.casefold():
            raise AssertionError(f"Expected iOS text {expected!r}, got {actual!r} for {resolved}.")
        return {"action": "assert-text", "resolvedLocator": resolved, "expected": expected, "actual": actual, "element": element}

    def _cmd_assert_value(self, params: dict[str, Any]) -> dict[str, Any]:
        expected = self._text(params.get("expected"))
        element, resolved = self._resolve_element(params.get("locator"), exact=True)
        actual = self._text(element.get("AXValue"))
        if actual != expected:
            raise AssertionError(f"Expected iOS AXValue {expected!r}, got {actual!r} for {resolved}.")
        return {"action": "assert-value", "resolvedLocator": resolved, "expected": expected, "actual": actual, "element": element}

    def _cmd_assert_not_visible(self, params: dict[str, Any]) -> dict[str, Any]:
        """Check that an element does not exist in the visible tree."""
        locator = params.get("locator")
        try:
            self._resolve_element(locator, exact=bool(params.get("exact", True)))
            raise AssertionError(f"Element still visible: {locator}")
        except (AssertionError, ValueError) as exc:
            if "not found" in str(exc):
                return {"action": "assert-not-visible", "locator": locator}
            raise

    def _cmd_assert_attribute(self, params: dict[str, Any]) -> dict[str, Any]:
        """Check a specific accessibility attribute of an element."""
        attr = params.get("attribute", "")
        expected = self._text(params.get("expected"))
        element, resolved = self._resolve_element(params.get("locator"), exact=True)
        actual = self._text(element.get(attr))
        if actual != expected:
            raise AssertionError(f"Expected {attr}={expected!r}, got {actual!r} for {resolved}.")
        return {"action": "assert-attribute", "attribute": attr, "expected": expected, "actual": actual, "resolvedLocator": resolved}

    def _cmd_assert_count(self, params: dict[str, Any]) -> dict[str, Any]:
        """Check the number of visible elements matching a locator."""
        locator = params.get("locator")
        expected = int(params.get("expected", 0))
        tree = self._read_tree()
        count = self._count_matches(locator, tree)
        if count != expected:
            raise AssertionError(f"Expected count {expected}, got {count} for {locator}.")
        return {"action": "assert-count", "expected": expected, "actual": count, "locator": locator}

    def _count_matches(self, locator: dict[str, Any] | None, tree: list[dict[str, Any]]) -> int:
        """Count visible elements matching a locator without raising ambiguity errors."""
        if not locator:
            return 0
        strategy = str(locator.get("strategy", "accessibility"))
        value = self._text(locator.get("value"))
        if strategy == "coordinate":
            return 1  # Coordinates always match exactly one point
        count = 0
        for element in tree:
            if not self._is_visible(element):
                continue
            element_type = self._text(element.get("type") or element.get("role") or element.get("role_description"))
            if strategy in ("accessibility", "label", "text"):
                if self._matches_text(element, value, True) or self._matches_text(element, value, False):
                    count += 1
            elif strategy == "value":
                if self._text(element.get("AXValue")) == value:
                    count += 1
            elif strategy in ("role", "type"):
                role = value
                name: str | None = None
                if strategy == "role" and ":" in value:
                    role, name = value.split(":", 1)
                if role.casefold() in element_type.casefold():
                    if name is None or self._matches_text(element, name, False):
                        count += 1
        return count

    def _cmd_screenshot(self, params: dict[str, Any]) -> dict[str, Any]:
        return {"action": "screenshot", "name": params.get("name", "explicit")}

    def _cmd_wait(self, params: dict[str, Any]) -> dict[str, Any]:
        locator = params.get("locator")
        if locator:
            element, resolved = self._wait_for_tree(
                lambda tree: self._resolve_from_tree(tree, locator, bool(params.get("exact", True))),
                f"iOS locator {locator}",
                float(params.get("timeout", 30)),
            )
            return {"action": "wait", "resolvedLocator": resolved, "element": element}
        ms = int(params.get("ms", 1000))
        if ms < 0:
            raise ValueError("wait ms must not be negative.")
        time.sleep(ms / 1000.0)
        return {"action": "wait", "ms": ms}

    def _resolve_from_tree(self, tree: list[dict[str, Any]], locator: dict[str, Any], exact: bool = True) -> tuple[dict[str, Any], dict[str, Any]] | None:
        try:
            return self._resolve_element(locator, exact, tree)
        except (AssertionError, ValueError):
            return None

    def _cmd_key(self, params: dict[str, Any]) -> dict[str, Any]:
        keycode = params.get("keycode")
        key = params.get("key", "")
        aliases = {"right": 79, "arrowright": 79, "backspace": 42, "delete": 42, "return": 40, "enter": 40, "tab": 43, "escape": 41}
        if keycode is None and isinstance(key, str) and key.casefold() in aliases:
            self._send_hid([aliases[key.casefold()]])
            self._wait_for_settle()
            return {"action": "key", "key": key, "keycode": aliases[key.casefold()]}
        keycode = keycode or key
        if keycode == "":
            raise ValueError("key requires a keycode or named key.")
        result = self._idb("ui", "key", str(keycode))
        if result.returncode != 0:
            raise RuntimeError(f"Key press failed on {self._udid}: {result.stderr.strip()}")
        self._wait_for_settle()
        return {"action": "key", "keycode": keycode}

    def _cmd_press(self, params: dict[str, Any]) -> dict[str, Any]:
        return self._cmd_key(params)

    def _cmd_describe(self, params: dict[str, Any]) -> dict[str, Any]:
        tree = self._read_tree()
        return {"action": "describe", "tree": tree, "count": len(tree), "screen": self._screen_bounds(tree)}
