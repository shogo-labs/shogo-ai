"""Multi-turn planning track-specific quality metrics.

Two sub-track metric functions:
  - multiturn_plan_quality: for ConversationPlanner
  - multiturn_summary_quality: for SessionSummarizer
"""

import dspy


VALID_TOOLS = {
    "exec", "read_file", "write_file", "edit_file", "delete_file",
    "web", "browser",
    "memory_read", "memory_search",
    "send_message", "cron", "read_lints",
}


# ---------------------------------------------------------------------------
# Planning metrics
# ---------------------------------------------------------------------------

def plan_completeness(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Planned tool sequence covers all needed steps."""
    expected = getattr(example, "planned_tool_sequence", "")
    predicted = getattr(prediction, "planned_tool_sequence", "")

    expected_tools = [t.strip() for t in expected.split(",") if t.strip()] if expected else []
    predicted_tools = [t.strip() for t in predicted.split(",") if t.strip()] if predicted else []

    if not expected_tools:
        return 1.0 if not predicted_tools else 0.5
    if not predicted_tools:
        return 0.0

    expected_set = set(expected_tools)
    predicted_set = set(predicted_tools)
    missing = expected_set - predicted_set

    if not missing:
        return 1.0
    return max(0.0, 1.0 - len(missing) / len(expected_set))


def plan_correctness(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """No impossible or invalid tool calls in the plan."""
    predicted = getattr(prediction, "planned_tool_sequence", "")
    if not predicted:
        return 1.0

    predicted_tools = [t.strip() for t in predicted.split(",") if t.strip()]
    if not predicted_tools:
        return 1.0

    valid_count = sum(1 for t in predicted_tools if t in VALID_TOOLS)
    return valid_count / len(predicted_tools)


def batch_decision_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Did the model correctly identify whether tools can be batched?"""
    expected = getattr(example, "can_batch", None)
    predicted = getattr(prediction, "can_batch", None)

    if expected is None or predicted is None:
        return 0.5

    if isinstance(predicted, str):
        predicted = predicted.lower() in ("true", "yes", "1")

    return 1.0 if bool(expected) == bool(predicted) else 0.0


def multiturn_plan_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined planning quality: completeness (40%) + correctness (30%) + batching (30%)."""
    completeness = plan_completeness(example, prediction, trace)
    correctness = plan_correctness(example, prediction, trace)
    batch = batch_decision_correct(example, prediction, trace)
    return completeness * 0.40 + correctness * 0.30 + batch * 0.30


# ---------------------------------------------------------------------------
# Summarization metrics
# ---------------------------------------------------------------------------

def summary_preserves_context(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Compacted summary retains key facts from full history."""
    key_facts = getattr(example, "key_facts", "")
    summary = getattr(prediction, "summary", "")

    if not key_facts:
        return 1.0
    if not summary:
        return 0.0

    facts = [f.strip().lstrip("- ") for f in key_facts.split("\n") if f.strip().startswith("-")]
    if not facts:
        return 1.0

    summary_lower = summary.lower()
    preserved = 0
    for fact in facts:
        keywords = [w for w in fact.lower().split() if len(w) > 3]
        if not keywords:
            preserved += 1
            continue
        matches = sum(1 for kw in keywords if kw in summary_lower)
        if matches >= len(keywords) * 0.5:
            preserved += 1

    return preserved / len(facts)


def summary_concise(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Summary should be under 200 words."""
    summary = getattr(prediction, "summary", "")
    if not summary:
        return 0.0

    word_count = len(summary.split())
    if word_count <= 200:
        return 1.0
    return max(0.0, 1.0 - (word_count - 200) * 0.01)


def preferences_captured(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """User preferences from the conversation should be extracted."""
    expected = getattr(example, "user_preferences", "")
    predicted = getattr(prediction, "user_preferences", "")

    if not expected:
        return 1.0
    if not predicted:
        return 0.0

    expected_lower = expected.lower()
    predicted_lower = predicted.lower()

    expected_items = [i.strip() for i in expected_lower.split(",") if i.strip()]
    if not expected_items:
        return 1.0

    found = sum(1 for item in expected_items if any(w in predicted_lower for w in item.split(":") if len(w.strip()) > 3))
    return found / len(expected_items)


def multiturn_summary_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined summary quality: context (40%) + conciseness (30%) + preferences (30%)."""
    context = summary_preserves_context(example, prediction, trace)
    concise = summary_concise(example, prediction, trace)
    prefs = preferences_captured(example, prediction, trace)
    return context * 0.40 + concise * 0.30 + prefs * 0.30
