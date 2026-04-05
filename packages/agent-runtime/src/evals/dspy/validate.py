"""
Python bridge to the TypeScript validation harness.

Sends prediction data to validate-prediction.ts via subprocess and
returns structured validation results.

The harness executes predictions against the real agent-runtime
(DynamicAppManager, ManagedApiRuntime, etc.) and reports whether
the generated artifacts actually work.
"""

import json
import subprocess
from pathlib import Path

HARNESS_PATH = Path(__file__).resolve().parent.parent / "validate-prediction.ts"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent


def run_validation(track: str, prediction_data: dict, timeout: int = 30) -> dict:
    """Execute the TS validation harness and return results.

    Args:
        track: Validation type — one of 'canvas', 'skill_write',
               'multiturn_plan'
        prediction_data: Dict of prediction fields to validate
        timeout: Subprocess timeout in seconds

    Returns:
        {valid: bool, score: float, checks: [...], errors: [...]}
    """
    payload = {"track": track, **prediction_data}

    try:
        result = subprocess.run(
            ["bun", "run", str(HARNESS_PATH)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(REPO_ROOT),
        )

        if result.returncode != 0:
            stderr = result.stderr.strip()[:500]
            return {
                "valid": False,
                "score": 0.0,
                "checks": [],
                "errors": [f"Harness exit code {result.returncode}: {stderr}"],
            }

        return json.loads(result.stdout.strip())

    except subprocess.TimeoutExpired:
        return {
            "valid": False,
            "score": 0.0,
            "checks": [],
            "errors": [f"Harness timed out after {timeout}s"],
        }
    except json.JSONDecodeError as e:
        return {
            "valid": False,
            "score": 0.0,
            "checks": [],
            "errors": [f"Invalid JSON from harness: {e}"],
        }
    except FileNotFoundError:
        return {
            "valid": False,
            "score": 0.0,
            "checks": [],
            "errors": ["bun not found — install bun to run e2e validation"],
        }


def validate_canvas(prediction) -> dict:
    """Validate a canvas prediction by executing it against DynamicAppManager."""
    return run_validation("canvas", {
        "surface_id": getattr(prediction, "surface_id", "test"),
        "component_tree_json": getattr(prediction, "component_tree_json", "[]"),
        "data_payload_json": getattr(prediction, "data_payload_json", "{}"),
        "needs_api_schema": getattr(prediction, "needs_api_schema", False),
        "api_models_json": getattr(prediction, "api_models_json", "[]"),
        "api_seed_json": getattr(prediction, "api_seed_json", "{}"),
    })


def validate_skill_write(prediction) -> dict:
    """Validate a skill creation prediction."""
    return run_validation("skill_write", {
        "skill_name": getattr(prediction, "skill_name", ""),
        "trigger_pattern": getattr(prediction, "trigger_pattern", ""),
        "required_tools": getattr(prediction, "required_tools", ""),
        "skill_body": getattr(prediction, "skill_body", ""),
    })


def validate_multiturn_plan(prediction) -> dict:
    """Validate a multiturn planning prediction."""
    return run_validation("multiturn_plan", {
        "planned_tool_sequence": getattr(prediction, "planned_tool_sequence", ""),
        "estimated_iterations": getattr(prediction, "estimated_iterations", 0),
        "can_batch": getattr(prediction, "can_batch", False),
    })




