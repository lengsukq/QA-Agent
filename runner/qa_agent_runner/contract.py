"""Result contract: validates result.json format and screenshot completeness."""

import json
from pathlib import Path
from typing import Any


RESULT_API_VERSION = "qa-agent/python-regression-result/v1"


def validate_result(result_path: Path) -> tuple[bool, list[str]]:
    """Validate a result.json file against the contract.

    Returns (is_valid, list_of_errors).
    """
    errors: list[str] = []

    if not result_path.exists():
        return False, [f"Result file not found: {result_path}"]

    try:
        with open(result_path) as f:
            doc = json.load(f)
    except json.JSONDecodeError as exc:
        return False, [f"Invalid JSON: {exc}"]

    # Check apiVersion
    if doc.get("apiVersion") != RESULT_API_VERSION:
        errors.append(f"apiVersion must be '{RESULT_API_VERSION}', got '{doc.get('apiVersion')}'")

    # Check required fields
    for field in ("status", "stepsTotal", "stepsPassed"):
        if field not in doc:
            errors.append(f"Missing required field: {field}")

    # Check status value
    status = doc.get("status", "")
    if status not in ("passed", "failed", "error"):
        errors.append(f"Invalid status: '{status}' (must be passed/failed/error)")

    # Check screenshot references
    screenshot_dir = doc.get("screenshotDir")
    if screenshot_dir:
        ss_dir = Path(screenshot_dir)
        steps = doc.get("steps", [])
        for step in steps:
            screenshot = step.get("screenshot")
            if screenshot and step.get("ok"):
                ss_path = ss_dir / screenshot
                if not ss_path.exists():
                    errors.append(f"Screenshot missing for step {step.get('stepId')}: {screenshot}")

    return len(errors) == 0, errors


def validate_steps_file(steps_path: Path) -> tuple[bool, list[str]]:
    """Validate a .steps.json regression file before publishing.

    Returns (is_valid, list_of_errors).
    """
    errors: list[str] = []

    if not steps_path.exists():
        return False, [f"Steps file not found: {steps_path}"]

    try:
        with open(steps_path) as f:
            doc = json.load(f)
    except json.JSONDecodeError as exc:
        return False, [f"Invalid JSON: {exc}"]

    # Check apiVersion
    expected_version = "qa-agent/regression-steps/v1"
    if doc.get("apiVersion") != expected_version:
        errors.append(f"apiVersion must be '{expected_version}', got '{doc.get('apiVersion')}'")

    # Check required fields
    for field in ("id", "platform", "steps"):
        if field not in doc:
            errors.append(f"Missing required field: {field}")

    # Check platform
    platform = doc.get("platform", "")
    if platform not in ("web", "ios"):
        errors.append(f"Unsupported platform: '{platform}' (must be web/ios)")

    # Check steps
    steps = doc.get("steps", [])
    if not steps:
        errors.append("Steps array is empty")

    for i, step in enumerate(steps):
        if "cmd" not in step:
            errors.append(f"Step {i}: missing 'cmd' field")
        if "id" not in step:
            errors.append(f"Step {i}: missing 'id' field")

    # Check no absolute paths in steps (portability)
    raw = steps_path.read_text()
    if "/Users/" in raw or "C:\\" in raw:
        errors.append("Steps file contains absolute paths — must be portable")

    return len(errors) == 0, errors
