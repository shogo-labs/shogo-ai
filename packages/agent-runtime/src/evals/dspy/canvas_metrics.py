"""Canvas track-specific quality metrics.

Evaluates CanvasPlanning signature outputs:
  - tool_sequence: ordered list of canvas tool calls
  - component_types: which UI components to use
  - needs_api_schema: CRUD vs data-only decision
  - surface_id: kebab-case identifier
"""

import re
import dspy


VALID_CANVAS_TOOLS = {
    "canvas_create", "canvas_update", "canvas_data",
    "canvas_delete", "canvas_action_wait", "canvas_components",
    "canvas_api_schema", "canvas_api_seed", "canvas_api_query",
}


def _parse_csv(val: str) -> list[str]:
    if not val or not isinstance(val, str):
        return []
    return [t.strip() for t in val.split(",") if t.strip()]


def tool_sequence_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Check if predicted tool sequence matches expected.

    Scores:
    - Tool set coverage (do we have all needed tools?)
    - Ordering (does canvas_create come first?)
    - No invalid tool names
    """
    expected = _parse_csv(getattr(example, "tool_sequence", ""))
    predicted = _parse_csv(getattr(prediction, "tool_sequence", ""))

    if not expected:
        return 1.0 if not predicted else 0.5
    if not predicted:
        return 0.0

    score = 0.0
    expected_set = set(expected)
    predicted_set = set(predicted)

    missing = expected_set - predicted_set
    coverage = 1.0 - len(missing) / len(expected_set)
    score += coverage * 0.4

    extra = predicted_set - expected_set - VALID_CANVAS_TOOLS
    invalid_penalty = len(extra) * 0.1
    score += max(0.0, 0.2 - invalid_penalty)

    if predicted and expected and predicted[0] == expected[0]:
        score += 0.2

    if len(predicted) == len(expected):
        score += 0.2
    elif len(predicted) <= len(expected) + 1:
        score += 0.1

    return min(max(score, 0.0), 1.0)


def component_types_match(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Check if predicted component types cover the needed types."""
    expected = set(_parse_csv(getattr(example, "component_types", "")))
    predicted = set(_parse_csv(getattr(prediction, "component_types", "")))

    if not expected:
        return 1.0
    if not predicted:
        return 0.0

    overlap = expected & predicted
    coverage = len(overlap) / len(expected)

    extra = len(predicted - expected)
    penalty = min(extra * 0.03, 0.15)

    return max(0.0, coverage - penalty)


def api_decision_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Check if needs_api_schema decision matches ground truth."""
    expected = bool(getattr(example, "needs_api_schema", False))
    predicted = getattr(prediction, "needs_api_schema", None)

    if predicted is None:
        return 0.0

    if isinstance(predicted, str):
        predicted = predicted.lower() in ("true", "yes", "1")

    return 1.0 if bool(expected) == bool(predicted) else 0.0


def surface_id_valid(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Check that surface_id is kebab-case and reasonable."""
    predicted = getattr(prediction, "surface_id", "")
    if not predicted or not isinstance(predicted, str):
        return 0.0

    predicted = predicted.strip().strip("'\"")

    if re.match(r'^[a-z][a-z0-9-]*$', predicted):
        return 1.0
    if re.match(r'^[a-zA-Z][a-zA-Z0-9_-]*$', predicted):
        return 0.5
    return 0.2


def canvas_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined canvas quality: sequence (35%) + components (30%) + api decision (20%) + surface_id (15%)."""
    seq = tool_sequence_correct(example, prediction, trace)
    comps = component_types_match(example, prediction, trace)
    api = api_decision_correct(example, prediction, trace)
    sid = surface_id_valid(example, prediction, trace)
    return seq * 0.35 + comps * 0.30 + api * 0.20 + sid * 0.15
