"""
E2E validation metrics — execute predictions against the real runtime.

Two levels of E2E validation:

1. **Harness metrics** (original) — run DSPy prediction output through validate-prediction.ts
   which executes against DynamicAppManager in-process.

2. **Full agent E2E metrics** (new) — inject candidate prompt instructions into a live
   agent-runtime server via POST /agent/prompt-override, then send the real user message
   and score the agent's actual tool calls, response, and behavior.

Full E2E metrics require a running ServerPool. Use make_full_e2e_metric() to create
metric functions bound to a pool instance.
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
# Canvas E2E (harness-based, original)
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
# Skill Creation E2E (harness-based, original)
# ---------------------------------------------------------------------------

def skill_create_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate skill creation output: YAML structure, triggers, tools."""
    result = validate_skill_creation(prediction)
    return result.get("score", 0.0)


# ---------------------------------------------------------------------------
# Multiturn Plan E2E (harness-based, original)
# ---------------------------------------------------------------------------

def multiturn_plan_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate the planned tool sequence: ordering constraints, valid tools, batching."""
    result = validate_multiturn_plan(prediction)
    return result.get("score", 0.0)


# ---------------------------------------------------------------------------
# Memory Write E2E (harness-based, original)
# ---------------------------------------------------------------------------

def memory_write_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate memory write output: content, target file, conciseness."""
    result = validate_memory_write(prediction)
    return result.get("score", 0.0)


# ---------------------------------------------------------------------------
# Personality Update E2E (harness-based, original)
# ---------------------------------------------------------------------------

def personality_update_e2e_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """Validate personality update: file choice, section, content."""
    result = validate_personality_update(prediction)
    return result.get("score", 0.0)


# ===========================================================================
# Full Agent E2E Metrics (new) — run the real agent loop
# ===========================================================================

# Global pool and cost tracker references, set by optimize.py
_pool = None
_cost_tracker = None


def set_server_pool(pool):
    """Set the global ServerPool instance used by full E2E metrics."""
    global _pool
    _pool = pool


def set_cost_tracker(tracker):
    """Set the global CostTracker so E2E metrics can report agent-runtime token usage."""
    global _cost_tracker
    _cost_tracker = tracker


def _format_override_from_prediction(prediction, track: str) -> dict:
    """Extract candidate instructions/demos from DSPy prediction and format as prompt overrides.

    During MIPROv2/BootstrapFewShot optimization, DSPy varies the signature's
    docstring (instructions) and few-shot demos. We extract whatever the current
    program produced and format it into the override payload that
    POST /agent/prompt-override expects.
    """
    overrides = {}

    # Extract the reasoning/instructions if the prediction includes them
    reasoning = getattr(prediction, "reasoning", "")

    if track == "canvas":
        # Build a canvas examples override from the prediction's plan
        surface_id = getattr(prediction, "surface_id", "")
        tool_seq = getattr(prediction, "tool_sequence", "")
        comp_types = getattr(prediction, "component_types", "")
        needs_api = getattr(prediction, "needs_api_schema", False)

        if surface_id and tool_seq:
            overrides["canvas_examples"] = (
                f"### Optimized Planning Examples\n\n"
                f"**Current optimization trial:**\n"
                f"- Surface: `{surface_id}`\n"
                f"- Needs API: {'Yes' if needs_api else 'No'}\n"
                f"- Tools: {tool_seq}\n"
                f"- Components: {comp_types}\n"
                f"- Reasoning: {reasoning}\n"
            )

    elif track == "memory":
        should_write = getattr(prediction, "should_write", False)
        content = getattr(prediction, "content", "")
        target = getattr(prediction, "target_file", "")
        if isinstance(should_write, str):
            should_write = should_write.lower() in ("true", "yes", "1")

        overrides["memory_guide"] = (
            f"### Memory Decision Guide\n\n"
            f"**Write memory when:** The conversation contains facts, preferences, or outcomes "
            f"worth remembering long-term.\n"
            f"**Skip when:** The interaction is mechanical or trivial.\n"
            f"- Reasoning: {reasoning}\n"
        )

    elif track == "personality":
        overrides["personality_guide"] = (
            f"### Self-Update Decision Guide\n\n"
            f"Update personality files only for lasting behavioral changes.\n"
            f"- Reasoning: {reasoning}\n"
        )

    elif track == "multiturn":
        tool_seq = getattr(prediction, "planned_tool_sequence", "")
        iters = getattr(prediction, "estimated_iterations", 1)
        overrides["tool_planning_guide"] = (
            f"## Tool Planning\n\n"
            f"Plan the full tool sequence upfront. Batch independent tool calls.\n"
            f"- Reasoning: {reasoning}\n"
        )

    elif track == "skill":
        overrides["skill_matching_guide"] = (
            f"### Skill Matching\n\n"
            f"Match user messages to skills semantically.\n"
            f"- Reasoning: {reasoning}\n"
        )

    return overrides


def _format_override_from_program(program, track: str) -> dict:
    """Extract optimized instructions and demos from a compiled DSPy program.

    This is used to inject the *current trial's* prompt configuration into
    the agent runtime before running the E2E eval.
    """
    overrides = {}

    # Extract signature instructions (the docstring DSPy optimizes)
    instructions = ""
    demos_text = ""
    try:
        sig = program.predict.signature if hasattr(program, "predict") else None
        if sig and hasattr(sig, "instructions"):
            instructions = sig.instructions or ""

        demos = program.predict.demos if hasattr(program, "predict") and hasattr(program.predict, "demos") else []
        if demos:
            demo_lines = []
            for i, d in enumerate(demos[:4]):
                parts = []
                for k, v in d.items():
                    if k not in ("augmented",) and v:
                        parts.append(f"  {k}: {str(v)[:100]}")
                if parts:
                    demo_lines.append(f"**Example {i+1}:**\n" + "\n".join(parts))
            if demo_lines:
                demos_text = "\n\n".join(demo_lines)
    except Exception:
        pass

    content = ""
    if instructions:
        content += instructions + "\n\n"
    if demos_text:
        content += demos_text

    if not content:
        return overrides

    # Map track to the appropriate override key
    track_key_map = {
        "canvas": "canvas_examples",
        "memory": "memory_guide",
        "personality": "personality_guide",
        "multiturn": "tool_planning_guide",
        "skill": "skill_matching_guide",
    }
    key = track_key_map.get(track)
    if key:
        overrides[key] = content

    return overrides


def _score_agent_result(result: dict, example: dspy.Example) -> float:
    """Score a real agent eval result (from ServerPool.run_eval).

    Scoring formula:
        40% — passed (no errors, reasonable output)
        25% — tool efficiency (optimal_tool_calls vs actual)
        20% — iteration efficiency (optimal_iterations vs actual)
        15% — no anti-patterns (no repeated tools, no unnecessary clarification)
    """
    if result.get("error"):
        return 0.0

    tool_calls = result.get("toolCalls", [])
    step_count = result.get("stepCount", 0)
    text = result.get("text", "")

    actual_tools = len(tool_calls)
    actual_iters = step_count

    # Pass: agent produced non-empty output and used at least one tool
    has_output = bool(text.strip()) or actual_tools > 0
    failed_tools = sum(1 for t in tool_calls if t.get("error"))
    pass_score = 1.0 if (has_output and failed_tools == 0) else (0.5 if has_output else 0.0)

    # Tool efficiency
    optimal_tools = int(getattr(example, "optimal_tool_calls", 0))
    if optimal_tools == 0:
        tool_eff = 1.0 if actual_tools == 0 else max(0.0, 1.0 - actual_tools * 0.25)
    elif actual_tools <= optimal_tools:
        tool_eff = 1.0
    else:
        overshoot = actual_tools - optimal_tools
        tool_eff = max(0.0, 1.0 - overshoot * 0.15)

    # Iteration efficiency
    optimal_iters = int(getattr(example, "optimal_iterations", 1))
    if actual_iters <= optimal_iters:
        iter_eff = 1.0
    else:
        overshoot = actual_iters - optimal_iters
        iter_eff = max(0.0, 1.0 - overshoot * 0.20)

    # Anti-pattern check: repeated tool calls (3+ same in a row)
    tool_names = [t.get("name", "") for t in tool_calls]
    has_loop = False
    for i in range(2, len(tool_names)):
        if tool_names[i] == tool_names[i-1] == tool_names[i-2]:
            has_loop = True
            break

    # Unnecessary clarification
    clarification_phrases = ["what kind", "which one", "do you want", "would you prefer", "could you clarify"]
    has_clarification = any(p in text.lower() for p in clarification_phrases)
    anti_pattern_score = 1.0
    if has_loop:
        anti_pattern_score *= 0.5
    if has_clarification:
        anti_pattern_score *= 0.7

    return (
        pass_score * 0.40
        + tool_eff * 0.25
        + iter_eff * 0.20
        + anti_pattern_score * 0.15
    )


def make_full_e2e_metric(track: str, program_ref: list = None, timeout: int = 120):
    """Create a DSPy metric function that runs the full agent loop.

    Args:
        track: Track name (canvas, memory, personality, skill, multiturn)
        program_ref: Mutable list holding [program] — updated by optimize.py
                     before each optimization pass so the metric can extract
                     the current trial's instructions.
        timeout: Per-eval timeout in seconds

    Returns:
        A metric function compatible with DSPy optimizers.
    """

    def full_e2e_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
        if _pool is None:
            raise RuntimeError("ServerPool not initialized. Call set_server_pool() first.")

        worker_id = _pool.get_free_worker()
        if worker_id is None:
            worker_id = 0  # fallback to first worker

        # Build prompt overrides from the current program (if available)
        # or from the prediction itself
        overrides = {}
        if program_ref and program_ref[0] is not None:
            overrides = _format_override_from_program(program_ref[0], track)
        if not overrides:
            overrides = _format_override_from_prediction(prediction, track)

        # Inject optimized prompts
        if overrides:
            _pool.inject_prompt(worker_id, overrides)

        # Reset workspace state (canvas surfaces, memory) between evals
        _pool.reset_workspace(worker_id)

        # Re-inject after reset (reset clears overrides)
        if overrides:
            _pool.inject_prompt(worker_id, overrides)

        # Run the real eval
        user_message = getattr(example, "user_request", "") or getattr(example, "user_message", "")
        result = _pool.run_eval(worker_id, user_message, timeout=timeout)

        # Report agent-runtime tokens to the cost tracker
        if _cost_tracker is not None:
            _cost_tracker.add_agent_tokens(
                result.get("inputTokens", 0),
                result.get("outputTokens", 0),
                result.get("cacheReadTokens", 0),
                result.get("cacheWriteTokens", 0),
            )

        return _score_agent_result(result, example)

    full_e2e_metric.__name__ = f"full_e2e_{track}"
    return full_e2e_metric
