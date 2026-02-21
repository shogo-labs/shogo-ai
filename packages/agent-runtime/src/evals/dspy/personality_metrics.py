"""Personality track-specific quality metrics.

Two sub-track metric functions:
  - personality_selection_quality: for AgentTemplateSelection
  - personality_self_update_quality: for PersonalitySelfUpdate
"""

import dspy


# ---------------------------------------------------------------------------
# Template selection metrics
# ---------------------------------------------------------------------------

CATEGORY_MAP = {
    "personal-assistant": "personal", "code-buddy": "personal",
    "writing-coach": "personal", "fitness-tracker": "personal", "meal-planner": "personal",
    "github-monitor": "development", "ci-cd-manager": "development",
    "code-reviewer": "development", "devops-helper": "development", "api-tester": "development",
    "sales-tracker": "business", "customer-support": "business",
    "marketing-analyst": "business", "hr-assistant": "business",
    "research-agent": "research", "academic-helper": "research",
    "market-researcher": "research", "patent-analyzer": "research",
    "system-monitor": "operations", "log-analyzer": "operations",
    "incident-responder": "operations", "deploy-manager": "operations",
    "custom": "custom",
}


def template_accuracy(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """1.0 = exact match, 0.75 = same category, 0.0 = wrong."""
    expected = str(getattr(example, "template_id", "")).strip()
    predicted = str(getattr(prediction, "template_id", "")).strip()

    if not expected:
        return 1.0

    if predicted == expected:
        return 1.0

    expected_cat = CATEGORY_MAP.get(expected, "unknown")
    predicted_cat = CATEGORY_MAP.get(predicted, "unknown")
    if expected_cat == predicted_cat and expected_cat != "unknown":
        return 0.75

    return 0.0


def confidence_calibrated(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Confidence should be >= expected minimum and <= 1.0."""
    expected_min = float(getattr(example, "confidence", 0.0))
    predicted = getattr(prediction, "confidence", None)

    if predicted is None:
        return 0.0

    try:
        predicted = float(predicted)
    except (ValueError, TypeError):
        return 0.0

    if predicted < 0 or predicted > 1.0:
        return 0.0
    if predicted >= expected_min:
        return 1.0
    return predicted / max(expected_min, 0.01)


def personality_selection_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined selection quality: template accuracy (60%) + confidence calibration (40%)."""
    acc = template_accuracy(example, prediction, trace)
    conf = confidence_calibrated(example, prediction, trace)
    return acc * 0.60 + conf * 0.40


# ---------------------------------------------------------------------------
# Self-update metrics
# ---------------------------------------------------------------------------

def update_decision_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Did the model correctly decide whether to update?"""
    expected = getattr(example, "should_update", None)
    predicted = getattr(prediction, "should_update", None)

    if expected is None or predicted is None:
        return 0.0

    if isinstance(predicted, str):
        predicted = predicted.lower() in ("true", "yes", "1")

    return 1.0 if bool(expected) == bool(predicted) else 0.0


def update_target_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """If updating, did it pick the right file and section?"""
    expected_update = getattr(example, "should_update", False)
    if isinstance(expected_update, str):
        expected_update = expected_update.lower() in ("true", "yes", "1")

    if not expected_update:
        return 1.0

    expected_file = str(getattr(example, "file", "")).strip()
    predicted_file = str(getattr(prediction, "file", "")).strip()
    expected_section = str(getattr(example, "section", "")).strip().lower()
    predicted_section = str(getattr(prediction, "section", "")).strip().lower()

    score = 0.0
    if predicted_file == expected_file:
        score += 0.5
    if predicted_section == expected_section:
        score += 0.5
    elif expected_section and expected_section in predicted_section:
        score += 0.25

    return score


def personality_self_update_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined self-update quality: decision (50%) + target (50%)."""
    decision = update_decision_correct(example, prediction, trace)
    target = update_target_correct(example, prediction, trace)
    return decision * 0.50 + target * 0.50
