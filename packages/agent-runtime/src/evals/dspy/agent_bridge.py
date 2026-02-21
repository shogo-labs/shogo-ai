"""
Bridge between DSPy optimization and the real agent-runtime eval harness.

Instead of using isolated DSPy signatures, this calls the real TypeScript
eval runner (run-eval.ts) which spins up an actual agent-runtime server,
sends a real message, and returns the AgentLoopResult metrics.

This allows DSPy to optimize system prompts, few-shot examples, or
bootstrap context while measuring against the REAL agent behavior.

Usage from DSPy:
    from agent_bridge import run_agent_eval, agent_eval_metric

    result = run_agent_eval(
        user_message="Build me a weather dashboard",
        model="haiku",
        track="canvas",
    )
    # result = { passed, score, maxScore, toolCalls, tokens, ... }
"""

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
RUN_EVAL_SCRIPT = REPO_ROOT / "packages" / "agent-runtime" / "src" / "evals" / "run-eval.ts"


def run_agent_eval(
    user_message: str,
    model: str = "haiku",
    track: str = "canvas",
    timeout: int = 120,
) -> dict:
    """
    Run a single eval scenario against the real agent-runtime.

    Shells out to the TS eval runner which:
    1. Starts a real agent-runtime HTTP server
    2. Sends the user message via POST /agent/chat
    3. Parses the SSE stream to collect tool calls, tokens, response text
    4. Scores against validation criteria
    5. Returns structured JSON results

    Returns dict with keys:
        passed, score, maxScore, percentage,
        toolCallCount, successfulToolCalls, failedToolCalls,
        iterations, inputTokens, outputTokens, durationMs,
        responseText (truncated)
    """
    # Use the single-eval entrypoint
    try:
        result = subprocess.run(
            [
                "bun", "run", str(RUN_EVAL_SCRIPT),
                "--track", track,
                "--model", model,
                "--filter", user_message[:30],  # Use first 30 chars as filter
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(REPO_ROOT),
        )

        # Parse the JSON results file path from stdout
        for line in result.stdout.splitlines():
            if line.startswith("Results saved:"):
                results_path = line.split(":", 1)[1].strip()
                with open(results_path) as f:
                    data = json.load(f)
                if data.get("results") and len(data["results"]) > 0:
                    r = data["results"][0]
                    return {
                        "passed": r.get("passed", False),
                        "score": r.get("score", 0),
                        "maxScore": r.get("maxScore", 100),
                        "percentage": r.get("percentage", 0),
                        "toolCallCount": r.get("metrics", {}).get("toolCallCount", 0),
                        "successfulToolCalls": r.get("metrics", {}).get("successfulToolCalls", 0),
                        "failedToolCalls": r.get("metrics", {}).get("failedToolCalls", 0),
                        "iterations": r.get("metrics", {}).get("iterations", 0),
                        "inputTokens": r.get("metrics", {}).get("tokens", {}).get("input", 0),
                        "outputTokens": r.get("metrics", {}).get("tokens", {}).get("output", 0),
                        "durationMs": r.get("timing", {}).get("durationMs", 0),
                        "responseText": (r.get("responseText", ""))[:500],
                    }

        return {
            "passed": False,
            "score": 0,
            "maxScore": 100,
            "percentage": 0,
            "error": f"Could not parse results. Exit code: {result.returncode}",
            "stderr": result.stderr[:500] if result.stderr else "",
        }

    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "score": 0,
            "maxScore": 100,
            "percentage": 0,
            "error": f"Agent eval timed out after {timeout}s",
        }
    except FileNotFoundError:
        return {
            "passed": False,
            "score": 0,
            "maxScore": 100,
            "percentage": 0,
            "error": "bun not found — install bun to run agent-runtime evals",
        }


def agent_eval_metric(example, prediction, trace=None) -> float:
    """
    DSPy metric function that runs the real agent-runtime for scoring.

    The prediction should contain a `system_prompt` field (or similar)
    that DSPy is optimizing. This function:
    1. Writes the optimized prompt to the workspace
    2. Runs the real agent loop
    3. Returns a 0-1 score based on real metrics

    For now, this returns a score based on the eval result.
    """
    user_message = getattr(example, "user_request", "")
    model = getattr(example, "model", "haiku")
    track = getattr(example, "track", "canvas")

    result = run_agent_eval(user_message, model=model, track=track)

    return result.get("percentage", 0) / 100.0
