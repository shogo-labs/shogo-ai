"""Memory track-specific quality metrics.

Two sub-track metric functions:
  - memory_write_quality: for MemoryWriteDecision
  - memory_retrieval_quality: for MemoryRetrieval
"""

import dspy


# ---------------------------------------------------------------------------
# Write-decision metrics
# ---------------------------------------------------------------------------

def write_decision_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Check if the write/no-write decision matches ground truth."""
    expected = getattr(example, "should_write", None)
    predicted = getattr(prediction, "should_write", None)

    if expected is None or predicted is None:
        return 0.0

    if isinstance(predicted, str):
        predicted = predicted.lower() in ("true", "yes", "1")

    return 1.0 if bool(expected) == bool(predicted) else 0.0


def content_concise(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Memory entries should be under 100 words with specific details."""
    should_write = getattr(example, "should_write", False)
    if isinstance(should_write, str):
        should_write = should_write.lower() in ("true", "yes", "1")

    if not should_write:
        content = getattr(prediction, "content", "")
        return 1.0 if not content or content.strip() == "" else 0.5

    content = getattr(prediction, "content", "")
    if not content:
        return 0.0

    word_count = len(content.split())
    if word_count > 100:
        return max(0.0, 1.0 - (word_count - 100) * 0.02)
    if word_count < 3:
        return 0.2

    return 1.0


def no_memory_spam(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Don't write redundant entries that duplicate existing memory."""
    should_write = getattr(example, "should_write", False)
    predicted_write = getattr(prediction, "should_write", False)

    if isinstance(should_write, str):
        should_write = should_write.lower() in ("true", "yes", "1")
    if isinstance(predicted_write, str):
        predicted_write = predicted_write.lower() in ("true", "yes", "1")

    if not should_write and predicted_write:
        return 0.0

    if should_write and predicted_write:
        current = getattr(example, "current_memory", "").lower()
        content = getattr(prediction, "content", "").lower()
        if content and content in current:
            return 0.2
        return 1.0

    return 1.0


def memory_write_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined write quality: decision (50%) + conciseness (25%) + no-spam (25%)."""
    decision = write_decision_correct(example, prediction, trace)
    concise = content_concise(example, prediction, trace)
    spam = no_memory_spam(example, prediction, trace)
    return decision * 0.50 + concise * 0.25 + spam * 0.25


# ---------------------------------------------------------------------------
# Retrieval metrics
# ---------------------------------------------------------------------------

def retrieval_tool_correct(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Did the model pick the right retrieval strategy?"""
    expected = str(getattr(example, "tool_to_use", "none")).strip().lower()
    predicted = str(getattr(prediction, "tool_to_use", "none")).strip().lower()

    if expected == predicted:
        return 1.0

    both_none = expected in ("none", "") and predicted in ("none", "", "n/a")
    if both_none:
        return 1.0

    both_memory = expected.startswith("memory_") and predicted.startswith("memory_")
    if both_memory:
        return 0.5

    return 0.0


def retrieval_query_relevant(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Is the retrieval query/file relevant?"""
    expected = str(getattr(example, "query_or_file", "")).strip().lower()
    predicted = str(getattr(prediction, "query_or_file", "")).strip().lower()

    if not expected:
        return 1.0 if not predicted else 0.5
    if not predicted:
        return 0.0

    expected_words = set(expected.split())
    predicted_words = set(predicted.split())

    if expected_words & predicted_words:
        return 1.0

    if expected in predicted or predicted in expected:
        return 0.8

    return 0.2


def memory_retrieval_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Combined retrieval quality: tool choice (60%) + query relevance (40%)."""
    tool = retrieval_tool_correct(example, prediction, trace)
    query = retrieval_query_relevant(example, prediction, trace)
    return tool * 0.60 + query * 0.40
