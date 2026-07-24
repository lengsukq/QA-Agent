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
    run_dir = os.environ.get("QA_AGENT_REGRESSION_RUN_DIR")

    def _screenshot_rel(filename: str | None) -> str:
        """Return the screenshot path relative to the regression run directory."""
        if not filename:
            return ""
        if run_dir:
            try:
                return os.path.relpath(str(screenshot_dir / filename), run_dir)
            except ValueError:
                pass
        return f"screenshots/{filename}"

    def _describe(step: dict[str, Any]) -> str:
        """Build a human-readable name for a step from its cmd and params."""
        cmd = step.get("cmd", "")
        params = step.get("params", {}) or {}
        loc = params.get("locator") or {}
        loc_val = loc.get("value") if isinstance(loc, dict) else None
        if cmd == "navigate":
            return f"Navigate {params.get('url', '')}".strip()
        if cmd == "launch":
            return f"Launch {params.get('bundleId', '')}".strip()
        if cmd in ("click", "tap"):
            return f"Tap {loc_val or params.get('detail', '')}".strip()
        if cmd in ("fill", "type_text"):
            return f"Input {loc_val or ''}".strip()
        if cmd in ("assert_text", "assert_visible", "assert_value"):
            return f"Assert {params.get('expected', '') or loc_val or ''}".strip()
        if cmd == "assert_not_visible":
            return f"Assert not visible {loc_val or ''}".strip()
        if cmd == "assert_attribute":
            return f"Assert {params.get('attribute', '')}={params.get('expected', '')}".strip()
        if cmd == "assert_count":
            return f"Assert count {params.get('expected', '')} for {loc_val or ''}".strip()
        if cmd in ("check", "uncheck"):
            return f"{cmd.title()} {loc_val or ''}".strip()
        if cmd == "toggle":
            return f"Toggle {loc_val or ''}".strip()
        if cmd == "get_text":
            return f"Get text {loc_val or ''}".strip()
        if cmd == "accept_dialog":
            return f"Accept dialog {loc_val or ''}".strip()
        if cmd == "dismiss_dialog":
            return f"Dismiss dialog {loc_val or ''}".strip()
        if cmd == "upload":
            return f"Upload {params.get('filePath', '')}".strip()
        if cmd == "swipe":
            return f"Swipe {params.get('direction', '')}".strip()
        return f"{cmd} {loc_val or params.get('detail', '')}".strip() or (cmd or "step")

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

    # Execute business steps fail-fast. Once a critical step fails, do not
    # continue operating on an unknown native-app state. Cleanup still runs
    # below and is intentionally independent from the business flow.
    results: list[dict[str, Any]] = []
    start_time = time.time()
    stopped_after_failure = False

    for step in steps:
        step_id = step.get("id", f"replay-{len(results) + 1}")
        cmd = step.get("cmd", "")
        params = step.get("params", {}) or {}
        if stopped_after_failure:
            results.append({
                "id": step_id,
                "name": _describe(step),
                "status": "blocked",
                "expected": params.get("expected", ""),
                "actual": "Skipped because a previous business step failed.",
                "screenshot": "",
            })
            continue
        try:
            res = driver.execute(cmd, params, step_id)
        except Exception as exc:
            res = {"ok": False, "error": str(exc)}
        ok = bool(res.get("ok", False))
        results.append({
            "id": step_id,
            "name": _describe(step),
            "status": "passed" if ok else "failed",
            "expected": params.get("expected", ""),
            "actual": res.get("actual") or res.get("error", ""),
            "screenshot": _screenshot_rel(res.get("screenshot")),
        })
        if not ok:
            stopped_after_failure = True

    # Execute cleanup (always, even if steps failed)
    cleanup_results: list[dict[str, Any]] = []
    for i, step in enumerate(cleanup):
        step_id = step.get("id", f"cleanup-{i + 1}")
        cmd = step.get("cmd", "")
        params = step.get("params", {}) or {}
        try:
            res = driver.execute(cmd, params, step_id)
        except Exception as exc:
            res = {"ok": False, "error": str(exc)}
        ok = bool(res.get("ok", False))
        cleanup_results.append({
            "name": _describe(step) or f"cleanup-{i + 1}",
            "status": "passed" if ok else "failed",
            "screenshot": _screenshot_rel(res.get("screenshot")),
        })

    # Close driver
    try:
        driver.close()
    except Exception:
        pass

    elapsed = time.time() - start_time

    # Build the Runtime-compatible result contract
    steps_total = len(results)
    steps_passed = sum(1 for r in results if r["status"] == "passed")
    all_passed = steps_total > 0 and steps_passed == steps_total
    contract_ok = steps_total > 0 and all(r.get("screenshot") for r in results)
    status = "passed" if all_passed else "failed"
    contract_status = "completed" if contract_ok else "blocked"
    conclusion = f"Replay {status}: {steps_passed}/{steps_total} steps passed ({int(elapsed * 1000)}ms)"
    result_doc = {
        "apiVersion": "qa-agent/python-regression-result/v1",
        "status": status,
        "contractStatus": contract_status,
        "conclusion": conclusion,
        "platform": platform,
        "stepsTotal": steps_total,
        "stepsPassed": steps_passed,
        "stepsFailed": steps_total - steps_passed,
        "durationMs": int(elapsed * 1000),
        "steps": results,
        "cleanup": cleanup_results,
        "screenshotDir": str(screenshot_dir),
        "stoppedAfterFailure": stopped_after_failure,
    }

    result_path.parent.mkdir(parents=True, exist_ok=True)
    with open(result_path, "w") as f:
        json.dump(result_doc, f, indent=2, ensure_ascii=False)

    print(conclusion)
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
