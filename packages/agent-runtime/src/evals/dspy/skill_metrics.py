"""Skill track-specific quality metrics.

Two sub-track metric functions:
  - skill_match_quality: for SkillMatcher
  - skill_create_quality: for SkillCreation
"""

import dspy


# ---------------------------------------------------------------------------
# Matching metrics
# ---------------------------------------------------------------------------

RELATED_GROUPS = [
    {"git-summary", "daily-digest"},
    {"check-github", "deploy-status"},
    {"web-research", "check-github"},
]


def match_accuracy(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """1.0 = exact, 0.5 = related skill, 0.0 = wrong."""
    expected = str(getattr(example, "matched_skill", "")).strip().lower()
    predicted = str(getattr(prediction, "matched_skill", "")).strip().lower()

    if not expected:
        return 0.0

    if expected == predicted:
        return 1.0

    if expected == "none" and predicted in ("none", "null", ""):
        return 1.0

    for group in RELATED_GROUPS:
        if expected in group and predicted in group:
            return 0.5

    return 0.0


def match_confidence_calibrated(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Confidence should reflect match quality."""
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
    if expected_min == 0.0:
        return 1.0 if predicted <= 0.3 else 0.5
    if predicted >= expected_min:
        return 1.0
    return predicted / max(expected_min, 0.01)


def skill_match_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined match quality: accuracy (70%) + confidence (30%)."""
    acc = match_accuracy(example, prediction, trace)
    conf = match_confidence_calibrated(example, prediction, trace)
    return acc * 0.70 + conf * 0.30


# ---------------------------------------------------------------------------
# Creation metrics
# ---------------------------------------------------------------------------

def trigger_coverage(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Generated triggers should cover semantic variations.

    Checks: >= 3 phrases, no single-word generics, phrases are distinct.
    """
    trigger = getattr(prediction, "trigger_pattern", "")
    if not trigger:
        return 0.0

    phrases = [p.strip() for p in trigger.split("|") if p.strip()]

    if len(phrases) < 2:
        return 0.2

    score = 0.0

    if len(phrases) >= 3:
        score += 0.4
    elif len(phrases) >= 2:
        score += 0.2

    generic_singles = {"check", "do", "run", "make", "get", "help", "show"}
    bad_singles = sum(1 for p in phrases if p.lower() in generic_singles)
    if bad_singles == 0:
        score += 0.3
    else:
        score += max(0.0, 0.3 - bad_singles * 0.1)

    distinct = True
    for i, p1 in enumerate(phrases):
        for j, p2 in enumerate(phrases):
            if i != j and p1.lower() in p2.lower() and len(p1) < len(p2) * 0.5:
                distinct = False
                break
    score += 0.3 if distinct else 0.1

    return min(score, 1.0)


def tools_appropriate(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Required tools list matches what the skill actually needs (Jaccard similarity)."""
    expected_tools = getattr(example, "required_tools", "")
    predicted_tools = getattr(prediction, "required_tools", "")

    if not expected_tools:
        return 1.0
    if not predicted_tools:
        return 0.0

    expected_set = {t.strip().lower() for t in expected_tools.split(",") if t.strip()}
    predicted_set = {t.strip().lower() for t in predicted_tools.split(",") if t.strip()}

    if not expected_set:
        return 1.0

    intersection = expected_set & predicted_set
    union = expected_set | predicted_set
    return len(intersection) / len(union) if union else 1.0


def skill_name_valid(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Skill name should be kebab-case and meaningful."""
    import re
    predicted = str(getattr(prediction, "skill_name", "")).strip()
    if not predicted:
        return 0.0
    if re.match(r'^[a-z][a-z0-9-]+$', predicted):
        return 1.0
    if re.match(r'^[a-zA-Z][a-zA-Z0-9_-]+$', predicted):
        return 0.5
    return 0.2


def skill_create_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined creation quality: triggers (35%) + tools (30%) + name (15%) + has body (20%)."""
    triggers = trigger_coverage(example, prediction, trace)
    tools = tools_appropriate(example, prediction, trace)
    name = skill_name_valid(example, prediction, trace)
    body = getattr(prediction, "skill_body", "")
    body_score = 1.0 if body and len(str(body).strip()) > 20 else (0.3 if body else 0.0)
    return triggers * 0.35 + tools * 0.30 + name * 0.15 + body_score * 0.20
