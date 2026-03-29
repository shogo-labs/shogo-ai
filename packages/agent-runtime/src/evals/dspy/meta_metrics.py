"""
Universal Meta-Metrics for Agent-Runtime DSPy Optimization

Every optimization track is scored by these 3 meta-metrics. At the DSPy
prompt-evaluation level, we derive scores from the model's *predicted plan*
rather than actual runtime values (which don't exist in predictions).

The metrics extract planned tool counts from whichever prediction field is
available (tool_sequence, planned_tool_sequence, or inferred from decision
fields like should_write / should_update / tool_to_use).

Final track score = universal_score (60%) + track_quality_score (40%).
"""

import dspy


ALL_VALID_TOOLS = {
    "exec", "read_file", "write_file", "edit_file", "delete_file",
    "glob", "grep", "ls", "web", "browser",
    "memory_read", "memory_search",
    "send_message", "cron", "canvas_lint",
    "identity_set", "skill_create",
}


def _parse_tool_list(csv_str):
    if not csv_str or not isinstance(csv_str, str):
        return []
    return [t.strip() for t in csv_str.split(",") if t.strip()]


def _extract_planned_tools(prediction):
    """Extract the planned tool list from any prediction type."""
    for field in ("tool_sequence", "planned_tool_sequence"):
        val = getattr(prediction, field, None)
        if val and isinstance(val, str) and val.strip():
            return _parse_tool_list(val)
    return []


def _extract_planned_tool_count(prediction):
    """Get a planned tool count, inferring from decision fields if no tool list."""
    tools = _extract_planned_tools(prediction)
    if tools:
        return len(tools)

    # CanvasE2E: produced executable artifacts → implies canvas tool calls
    component_tree = getattr(prediction, "component_tree_json", None)
    if component_tree and str(component_tree).strip() not in ("", "[]"):
        needs_api = getattr(prediction, "needs_api_schema", False)
        if isinstance(needs_api, str):
            needs_api = needs_api.lower() in ("true", "yes", "1")
        return 5 if needs_api else 3  # create+update+data (+api_schema+api_seed)

    for field in ("should_write", "should_update"):
        val = getattr(prediction, field, None)
        if val is not None:
            if isinstance(val, str):
                val = val.lower() in ("true", "yes", "1")
            return 1 if val else 0

    tool = getattr(prediction, "tool_to_use", None)
    if tool is not None:
        return 0 if str(tool).strip().lower() in ("none", "", "n/a") else 1

    skill_body = getattr(prediction, "skill_body", None)
    if skill_body and str(skill_body).strip():
        return 1

    matched_skill = getattr(prediction, "matched_skill", None)
    if matched_skill is not None:
        return 0

    # Session summarizer: produces a summary → no tool calls expected
    summary = getattr(prediction, "summary", None)
    if summary and str(summary).strip():
        return 0

    return 0


def _extract_iterations(prediction):
    """Extract iteration estimate from prediction."""
    val = getattr(prediction, "estimated_iterations", None)
    if val is not None:
        try:
            return int(val)
        except (ValueError, TypeError):
            pass
    count = _extract_planned_tool_count(prediction)
    return 1 if count > 0 else 0


# ---------------------------------------------------------------------------
# 1. Tool Call Efficiency (40%) — did the model plan the right number?
# ---------------------------------------------------------------------------

def tool_call_efficiency(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Score based on how close planned tool calls are to the optimal count.

    Returns:
        1.0  if planned <= optimal (at or under budget)
        Decays by 15% per extra call, floored at 0.0
    """
    optimal = int(getattr(example, "optimal_tool_calls", 0))
    actual = _extract_planned_tool_count(prediction)

    if optimal == 0 and actual == 0:
        return 1.0
    if optimal == 0 and actual > 0:
        return max(0.0, 1.0 - (actual * 0.25))
    if actual <= optimal:
        return 1.0

    overshoot = actual - optimal
    return max(0.0, 1.0 - (overshoot * 0.15))


# ---------------------------------------------------------------------------
# 2. Success Ratio (35%) — are planned tools valid?
# ---------------------------------------------------------------------------

def success_ratio(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Ratio of valid (recognized) tool names to total planned tools.

    Returns:
        1.0  if all planned tools are valid names (or no tools planned and none needed)
        0.0  if tools expected but none planned
    """
    optimal = int(getattr(example, "optimal_tool_calls", 0))
    tools = _extract_planned_tools(prediction)

    if not tools:
        if optimal == 0:
            return 1.0
        count = _extract_planned_tool_count(prediction)
        return 1.0 if count > 0 else 0.0

    valid = sum(1 for t in tools if t in ALL_VALID_TOOLS)
    return valid / len(tools)


# ---------------------------------------------------------------------------
# 3. Latency Score (25%) — minimize LLM round-trips
# ---------------------------------------------------------------------------

def latency_score(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Score based on estimated iterations (LLM round-trips).

    Returns:
        1.0  if estimated iterations <= optimal
        Decays by 20% per extra iteration, floored at 0.0
    """
    optimal_iters = int(getattr(example, "optimal_iterations", 1))
    actual_iters = _extract_iterations(prediction)

    if actual_iters <= optimal_iters:
        return 1.0

    overshoot = actual_iters - optimal_iters
    return max(0.0, 1.0 - (overshoot * 0.20))


# ---------------------------------------------------------------------------
# Universal Combined Score
# ---------------------------------------------------------------------------

def universal_score(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Weighted combination of the 3 meta-metrics.

    Weights:
        Tool call efficiency:  40%
        Success ratio:         35%
        Latency score:         25%
    """
    efficiency = tool_call_efficiency(example, prediction, trace)
    success = success_ratio(example, prediction, trace)
    latency = latency_score(example, prediction, trace)
    return efficiency * 0.40 + success * 0.35 + latency * 0.25


def combined_track_score(
    example: dspy.Example,
    prediction: dspy.Prediction,
    track_quality_fn,
    trace=None,
) -> float:
    """Final score for any track: universal (60%) + track-specific quality (40%)."""
    meta = universal_score(example, prediction, trace)
    quality = track_quality_fn(example, prediction, trace)
    return meta * 0.60 + quality * 0.40


# ---------------------------------------------------------------------------
# Aggregate tracker
# ---------------------------------------------------------------------------

class MetaMetricsTracker:
    """Collect per-example scores and print a summary."""

    def __init__(self):
        self.results = []

    def add(self, example, prediction, track_quality_fn=None):
        entry = {
            "efficiency": tool_call_efficiency(example, prediction),
            "success": success_ratio(example, prediction),
            "latency": latency_score(example, prediction),
            "universal": universal_score(example, prediction),
        }
        if track_quality_fn:
            entry["track_quality"] = track_quality_fn(example, prediction)
            entry["final"] = combined_track_score(example, prediction, track_quality_fn)
        self.results.append(entry)

    def summary(self) -> dict:
        if not self.results:
            return {}
        n = len(self.results)

        def avg(key):
            vals = [r[key] for r in self.results if key in r]
            return sum(vals) / len(vals) if vals else 0.0

        s = {
            "total": n,
            "avg_efficiency": avg("efficiency"),
            "avg_success": avg("success"),
            "avg_latency": avg("latency"),
            "avg_universal": avg("universal"),
        }
        if "track_quality" in self.results[0]:
            s["avg_track_quality"] = avg("track_quality")
            s["avg_final"] = avg("final")
        return s

    def print_summary(self):
        s = self.summary()
        if not s:
            print("No results yet")
            return
        print(f"\n{'=' * 55}")
        print("UNIVERSAL META-METRICS")
        print(f"{'=' * 55}")
        print(f"  Total examples:        {s['total']}")
        print(f"  Avg efficiency (40%):  {s['avg_efficiency']:.3f}")
        print(f"  Avg success    (35%):  {s['avg_success']:.3f}")
        print(f"  Avg latency    (25%):  {s['avg_latency']:.3f}")
        print(f"  Avg universal:         {s['avg_universal']:.3f}")
        if "avg_final" in s:
            print(f"  Avg track quality:     {s['avg_track_quality']:.3f}")
            print(f"  Avg FINAL score:       {s['avg_final']:.3f}")
        print(f"{'=' * 55}\n")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    ex = dspy.Example(optimal_tool_calls=3, optimal_iterations=1)

    good = dspy.Prediction(tool_sequence="canvas_create, canvas_update, canvas_data")
    ok = dspy.Prediction(tool_sequence="canvas_create, canvas_update, canvas_data, canvas_data, canvas_delete")
    bad = dspy.Prediction(tool_sequence="canvas_create, canvas_update, canvas_data, bogus_tool, fake_tool, extra, extra2, extra3")

    for label, pred in [("good", good), ("ok", ok), ("bad", bad)]:
        print(f"{label}: efficiency={tool_call_efficiency(ex, pred):.2f}  "
              f"success={success_ratio(ex, pred):.2f}  "
              f"latency={latency_score(ex, pred):.2f}  "
              f"universal={universal_score(ex, pred):.2f}")
