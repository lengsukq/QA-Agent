"""Regression replay: reads a .steps.json file and re-executes each step via the platform driver."""

import json
import os
import sys
import time
from pathlib import Path
from typing import Any


def run_replay(steps_file: str) -> None:
    """Execute a regression steps file and produce result.json + screenshots.

    Environment variables (set by Runtime):
      QA_AGENT_SCREENSHOT_DIR - directory for checkpoint screenshots
      QA_AGENT_RESULT_PATH    - path to write structured result JSON
    """
    screenshot_dir = Path(os.environ.get("QA_AGENT_SCREENSHOT_DIR", "./screenshots"))
    result_path = Path(os.environ.get("QA_AGENT_RESULT_PATH", "./result.json"))
    screenshot_dir.mkdir(parents=True, exist_ok=True)

    steps_path = Path(steps_file)
    if not steps_path.exists():
        _write_failure(result_path, f"Steps file not found: {steps_file}")
        sys.exit(1)

    with open(steps_path) as f:
        steps_doc = json.load(f)

    platform = steps_doc.get("platform", "web")
    steps = steps_doc.get("steps", [])
    cleanup = steps_doc.get("cleanup", [])
    env_vars: dict[str, str] = steps_doc.get("env", {})
    device_udid: str | None = steps_doc.get("deviceUdid")

    # Initialize driver
    driver: Any = None
    try:
        if platform == "web":
            from qa_agent_runner.web import WebDriver
            driver = WebDriver(screenshot_dir, env_vars)
        elif platform == "ios":
            from qa_agent_runner.ios import IosDriver
            driver = IosDriver(screenshot_dir, env_vars, device_udid)
        else:
            _write_failure(result_path, f"Unsupported platform: {platform}")
            sys.exit(1)
    except Exception as exc:
        _write_failure(result_path, f"Driver init failed: {exc}")
        sys.exit(1)

    # Execute steps
    results: list[dict[str, Any]] = []
    all_passed = True
    start_time = time.time()

    for step in steps:
        step_id = step.get("id", f"replay-{len(results) + 1}")
        cmd = step.get("cmd", "")
        params = step.get("params", {})

        try:
            result = driver.execute(cmd, params, step_id)
            results.append({"stepId": step_id, "cmd": cmd, **result})
            if not result.get("ok", False):
                all_passed = False
                break  # Stop on first failure
        except Exception as exc:
            results.append({"stepId": step_id, "cmd": cmd, "ok": False, "error": str(exc)})
            all_passed = False
            break

    # Execute cleanup (always, even if steps failed)
    cleanup_results: list[dict[str, Any]] = []
    for i, step in enumerate(cleanup):
        step_id = step.get("id", f"cleanup-{i + 1}")
        cmd = step.get("cmd", "")
        params = step.get("params", {})
        try:
            result = driver.execute(cmd, params, step_id)
            cleanup_results.append({"stepId": step_id, "cmd": cmd, **result})
        except Exception as exc:
            cleanup_results.append({"stepId": step_id, "cmd": cmd, "ok": False, "error": str(exc)})

    # Close driver
    try:
        driver.close()
    except Exception:
        pass

    elapsed = time.time() - start_time

    # Write result
    status = "passed" if all_passed else "failed"
    result_doc = {
        "apiVersion": "qa-agent/python-regression-result/v1",
        "status": status,
        "platform": platform,
        "stepsTotal": len(steps),
        "stepsPassed": sum(1 for r in results if r.get("ok")),
        "stepsFailed": sum(1 for r in results if not r.get("ok")),
        "durationMs": int(elapsed * 1000),
        "steps": results,
        "cleanup": cleanup_results,
        "screenshotDir": str(screenshot_dir),
    }

    result_path.parent.mkdir(parents=True, exist_ok=True)
    with open(result_path, "w") as f:
        json.dump(result_doc, f, indent=2, ensure_ascii=False)

    print(f"Replay {status}: {result_doc['stepsPassed']}/{result_doc['stepsTotal']} steps passed ({result_doc['durationMs']}ms)")
    sys.exit(0 if all_passed else 1)


def _write_failure(result_path: Path, error: str) -> None:
    result_path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "apiVersion": "qa-agent/python-regression-result/v1",
        "status": "failed",
        "error": error,
        "stepsTotal": 0,
        "stepsPassed": 0,
        "stepsFailed": 0,
    }
    with open(result_path, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    print(f"Replay failed: {error}", file=sys.stderr)
