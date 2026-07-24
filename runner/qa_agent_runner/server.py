"""Command server: reads JSON commands from stdin, executes UI actions, returns JSON results.

Protocol:
  - First line from stdin is the config: {"platform":"web","screenshotDir":"...","env":{...}}
  - Subsequent lines are commands: {"cmd":"click","locator":{"strategy":"role","value":"button:OK"}}
  - Each command returns one JSON line: {"ok":true,"screenshot":"agent-1.png","actual":"..."}
  - {"cmd":"close"} shuts down the driver.
"""

import json
import sys
from pathlib import Path
from typing import Any


def _respond(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _error(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}


def run_server() -> None:
    """Main server loop. Reads config then processes commands until close/EOF."""
    config_line = sys.stdin.readline()
    if not config_line.strip():
        _respond(_error("No config received."))
        return

    try:
        config = json.loads(config_line)
    except json.JSONDecodeError as exc:
        _respond(_error(f"Invalid config JSON: {exc}"))
        return

    platform = config.get("platform", "web")
    screenshot_dir = Path(config.get("screenshotDir", "."))
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    env_vars: dict[str, str] = config.get("env", {})
    device_udid: str | None = config.get("deviceUdid")

    # Initialize platform driver
    driver: Any = None
    try:
        if platform == "web":
            from qa_agent_runner.web import WebDriver

            driver = WebDriver(screenshot_dir, env_vars)
        elif platform == "ios":
            from qa_agent_runner.ios import IosDriver

            driver = IosDriver(screenshot_dir, env_vars, device_udid)
        else:
            _respond(_error(f"Unsupported platform: {platform}"))
            return
    except Exception as exc:
        _respond(_error(f"Driver init failed: {exc}"))
        return

    _respond({"ok": True, "ready": True, "platform": platform})

    # Command loop
    step_counter = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond(_error(f"Invalid command JSON: {exc}"))
            continue

        cmd = command.get("cmd", "")
        if cmd == "close":
            try:
                driver.close()
            except Exception:
                pass
            _respond({"ok": True})
            break

        step_counter += 1
        step_id = command.get("stepId", f"agent-{step_counter}")

        try:
            params = command.get("params", {})
            if not params:
                # Support flat commands where CLI places params at root level
                params = {k: v for k, v in command.items() if k not in ("cmd", "stepId")}
            result = driver.execute(cmd, params, step_id)
            _respond(result)
        except Exception as exc:
            _respond({**_error(str(exc)), "stepId": step_id})

    # Cleanup on EOF
    try:
        driver.close()
    except Exception:
        pass
