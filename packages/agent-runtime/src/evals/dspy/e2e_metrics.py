"""
E2E validation metrics — execute predictions against the real runtime.

These metrics call the TypeScript validation harness via subprocess,
which runs the model's output through the actual DynamicAppManager,
ManagedApiRuntime, etc. and returns pass/fail checks.

Each track has an e2e quality function that combines the harness score
with structural checks on the prediction output.
"""

import dspy
from validate import (
    validate_canvas,
    validate_skill_creation,
    validate_multiturn_plan,
    validate_memory_write,
    validate_personality_update,
)


# ---------------------------------------------------------------------------
# Canvas E2E
# ---------------------------------------------------------------------------

def canvas_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Execute the canvas prediction against DynamicAppManager and score.

    The harness checks: JSON parseable, surface created, components valid,
    data bindings resolve, root exists, children resolve, etc.
    """
    result = validate_canvas(prediction)
    harness_score = result.get("score", 0.0)

    # Bonus: check component count matches expectation
    expected_count = int(getattr(example, "expected_component_count", 0))
    if expected_count > 0:
        for check in result.get("checks", []):
            if check.get("name") == "component_count" and not check.get("pass"):
                harness_score *= 0.8

    # Penalty for any errors
    error_count = len(result.get("errors", []))
    if error_count > 0:
        harness_score *= max(0.5, 1.0 - error_count * 0.1)

    return min(harness_score, 1.0)


# ---------------------------------------------------------------------------
# Skill Creation E2E
# ---------------------------------------------------------------------------

def skill_create_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate skill creation output: YAML structure, triggers, tools."""
    result = validate_skill_creation(prediction)
    return result.get("score", 0.0)


# ---------------------------------------------------------------------------
# Multiturn Plan E2E
# ---------------------------------------------------------------------------

def multiturn_plan_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate the planned tool sequence: ordering constraints, valid tools, batching."""
    result = validate_multiturn_plan(prediction)
    return result.get("score", 0.0)


# ---------------------------------------------------------------------------
# Memory Write E2E
# ---------------------------------------------------------------------------

def memory_write_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate memory write output: content, target file, conciseness."""
    result = validate_memory_write(prediction)
    return result.get("score", 0.0)


# ---------------------------------------------------------------------------
# Personality Update E2E
# ---------------------------------------------------------------------------

def personality_update_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate personality update: file choice, section, content."""
    result = validate_personality_update(prediction)
    return result.get("score", 0.0)
