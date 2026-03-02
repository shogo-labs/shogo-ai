"""
Bridge between DSPy optimization and the real agent-runtime eval harness.

Two modes of operation:

1. **Legacy (subprocess)** — shells out to run-eval.ts which spins up its
   own agent-runtime server per eval. Slow but standalone.

2. **Pool-based (recommended)** — uses a ServerPool instance for persistent
   workers. The pool is managed by optimize.py and injected via
   set_server_pool(). Prompt overrides are sent via HTTP before each eval.

Usage from DSPy:
    # Pool-based (preferred — used by --e2e mode in optimize.py)
    from server_pool import ServerPool
    from agent_bridge import set_pool, run_pooled_eval, pooled_eval_metric

    pool = ServerPool(num_workers=2, model="haiku")
    pool.start()
    set_pool(pool)

    result = run_pooled_eval("Build me a weather dashboard")
    score = pooled_eval_metric(example, prediction)

    pool.stop()

    # Legacy (standalone, spawns server per eval)
    from agent_bridge import run_agent_eval, agent_eval_metric

    result = run_agent_eval("Build me a weather dashboard", model="haiku", track="canvas")
"""

import json
import subprocess
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
RUN_EVAL_SCRIPT = REPO_ROOT / "packages" / "agent-runtime" / "src" / "evals" / "run-eval.ts"

# Global pool reference (set by optimize.py or caller)
_pool = None


def set_pool(pool):
    """Set the global ServerPool instance."""
    global _pool
    _pool = pool


def get_pool():
    """Get the current ServerPool instance."""
    return _pool


# ---------------------------------------------------------------------------
# Pool-based evaluation (new, recommended)
# ---------------------------------------------------------------------------

def run_pooled_eval(
    user_message: str,
    worker_id: int = 0,
    prompt_overrides: Optional[dict] = None,
    timeout: int = 120,
) -> dict:
    """Run a single eval against a pool worker with optional prompt overrides.

    Returns dict with keys:
        text, toolCalls, stepCount, inputTokens, outputTokens, durationMs, error?
    """
    if _pool is None:
        raise RuntimeError("No ServerPool set. Call set_pool() first or use run_agent_eval().")

    if prompt_overrides:
        _pool.inject_prompt(worker_id, prompt_overrides)

    result = _pool.run_eval(worker_id, user_message, timeout=timeout)
    return result


def pooled_eval_metric(example, prediction, trace=None) -> float:
    """DSPy metric that evaluates via the pool-based agent runtime.

    Uses the global ServerPool. The prompt overrides should have been
    injected by the caller (e.g., the full E2E metric functions in e2e_metrics.py).
    """
    if _pool is None:
        return legacy_eval_metric(example, prediction, trace)

    user_message = getattr(example, "user_request", "") or getattr(example, "user_message", "")
    worker_id = _pool.get_free_worker() or 0

    result = _pool.run_eval(worker_id, user_message, timeout=120)

    if result.get("error"):
        return 0.0

    tool_calls = result.get("toolCalls", [])
    text = result.get("text", "")
    has_output = bool(text.strip()) or len(tool_calls) > 0
    failed = sum(1 for t in tool_calls if t.get("error"))

    if not has_output:
        return 0.0

    score = 0.5
    if failed == 0:
        score += 0.3
    if len(tool_calls) > 0:
        score += 0.2

    return min(score, 1.0)


# ---------------------------------------------------------------------------
# Legacy evaluation (subprocess-based, spawns server per eval)
# ---------------------------------------------------------------------------

def run_agent_eval(
    user_message: str,
    model: str = "haiku",
    track: str = "canvas",
    timeout: int = 120,
) -> dict:
    """Run a single eval by shelling out to run-eval.ts (spawns its own server).

    This is the legacy path — slower than pool-based evaluation but works
    standalone without a pre-started ServerPool.

    Returns dict with keys:
        passed, score, maxScore, percentage,
        toolCallCount, successfulToolCalls, failedToolCalls,
        iterations, inputTokens, outputTokens, durationMs,
        responseText (truncated)
    """
    try:
        result = subprocess.run(
            [
                "bun", "run", str(RUN_EVAL_SCRIPT),
                "--track", track,
                "--model", model,
                "--filter", user_message[:30],
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(REPO_ROOT),
        )

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


def legacy_eval_metric(example, prediction, trace=None) -> float:
    """DSPy metric using the legacy subprocess approach."""
    user_message = getattr(example, "user_request", "")
    model = getattr(example, "model", "haiku")
    track = getattr(example, "track", "canvas")

    result = run_agent_eval(user_message, model=model, track=track)
    return result.get("percentage", 0) / 100.0


# Keep the old name for backward compatibility
agent_eval_metric = pooled_eval_metric