import subprocess
import unittest
from pathlib import Path

from qa_agent_runner.ios import IosDriver


class FakeIosDriver(IosDriver):
    def __init__(self):
        self._udid = "test-udid"
        self._screenshot_dir = Path("/tmp/qa-agent-ios-driver-test")
        self._env = {}
        self._idb_bin = "idb"
        self._companion = "/tmp/idb_companion"
        self.tree = [
            {"type": "TextField", "AXLabel": "Email", "AXValue": "old@example.com", "frame": {"x": 20, "y": 100, "width": 300, "height": 48}},
            {"type": "Button", "AXLabel": "Save", "AXValue": "", "frame": {"x": 20, "y": 700, "width": 120, "height": 48}},
        ]
        self.calls = []
        self.clears = []

    def _read_tree(self):
        return self.tree

    def _idb(self, *args):
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")

    def _wait_for_settle(self, timeout=5.0):
        return self.tree

    def _take_screenshot(self, step_id):
        return f"{step_id}.png"

    def _clear_focused_text(self, max_chars=250, reference=None):
        self.clears.append((max_chars, reference))


class IosDriverTests(unittest.TestCase):
    def test_semantic_locator_resolves_current_frame(self):
        driver = FakeIosDriver()
        element, locator = driver._resolve_element({"strategy": "accessibility", "value": "Email"})
        self.assertEqual(locator, {"strategy": "accessibility", "value": "Email"})
        self.assertEqual(driver._center(element), (170, 124))

    def test_fill_uses_semantic_locator_then_clears_and_types(self):
        driver = FakeIosDriver()
        actual = driver._cmd_fill({
            "locator": {"strategy": "label", "value": "Email"},
            "value": "new@example.com",
            "maxChars": 40,
        })
        self.assertEqual(driver.calls[0][:3], ("ui", "tap", "170"))
        self.assertEqual(driver.calls[1][:3], ("ui", "text", "new@example.com"))
        self.assertEqual(driver.clears[0][0], 40)
        self.assertEqual(actual["resolvedLocator"], {"strategy": "label", "value": "Email"})

    def test_swipe_uses_dynamic_tree_bounds(self):
        driver = FakeIosDriver()
        driver.tree.append({"type": "StaticText", "AXLabel": "Bottom", "frame": {"x": 0, "y": 0, "width": 390, "height": 844}})
        driver._cmd_swipe({"direction": "up"})
        self.assertEqual(driver.calls[-1], ("ui", "swipe", "195", "743", "195", "101"))

    def test_scroll_is_a_dynamic_swipe_alias(self):
        driver = FakeIosDriver()
        driver.tree.append({"type": "StaticText", "AXLabel": "Bottom", "frame": {"x": 0, "y": 0, "width": 390, "height": 844}})
        result = driver._cmd_scroll({"direction": "down"})
        self.assertEqual(result["action"], "scroll")
        self.assertEqual(driver.calls[-1], ("ui", "swipe", "195", "101", "195", "743"))

    def test_text_locator_matches_compound_accessibility_label(self):
        driver = FakeIosDriver()
        driver.tree.append({
            "type": "Image",
            "AXLabel": "Bvlgari\nAviator Sunglasses · S\nAED \n4,000",
            "frame": {"x": 16, "y": 208, "width": 198, "height": 296},
        })
        element, locator = driver._resolve_element({"strategy": "text", "value": "Bvlgari"})
        self.assertEqual(locator, {"strategy": "text", "value": "Bvlgari"})
        self.assertEqual(element["type"], "Image")

    def test_clear_sends_right_and_backspace_hid_events(self):
        driver = FakeIosDriver()
        sent = []
        driver._send_hid = lambda keycodes: sent.extend(keycodes)
        driver.tree[0]["AXValue"] = ""
        IosDriver._clear_focused_text(driver, 3)
        self.assertEqual(sent, [79, 79, 79, 42, 42, 42])

    def test_assert_value_is_exact(self):
        driver = FakeIosDriver()
        driver.tree[0]["AXValue"] = "expected"
        result = driver._cmd_assert_value({"locator": {"strategy": "label", "value": "Email"}, "expected": "expected"})
        self.assertEqual(result["actual"], "expected")

    def test_execute_returns_structured_result_and_failure_screenshot(self):
        driver = FakeIosDriver()
        result = driver.execute("tap", {"locator": {"strategy": "label", "value": "Save"}}, "step-1")
        self.assertTrue(result["ok"])
        self.assertEqual(result["resolvedLocator"], {"strategy": "label", "value": "Save"})
        self.assertEqual(result["screenshot"], "step-1.png")


if __name__ == "__main__":
    unittest.main()
