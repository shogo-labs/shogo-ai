"""
Manages a pool of long-lived agent-runtime workers for E2E DSPy optimization.

Each worker is a real agent-runtime server process. The pool provides:
  - start/stop lifecycle for the server processes
  - inject_prompt() to update a worker's system prompt via HTTP
  - run_eval() to send a user message and collect real metrics
  - reset() to clear prompt overrides between trials

Usage:
    pool = ServerPool(num_workers=2, model="haiku")
    pool.start()

    pool.inject_prompt(0, {"canvas_examples": "...", "memory_guide": "..."})
    result = pool.run_eval(0, "Build me a weather dashboard")
    # result = { text, toolCalls, stepCount, inputTokens, outputTokens, durationMs }

    pool.stop()
"""

import json
import os
import shutil
import signal
import subprocess
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent.parent
AGENT_SERVER = REPO_ROOT / "packages" / "agent-runtime" / "src" / "server.ts"
SINGLE_EVAL = REPO_ROOT / "packages" / "agent-runtime" / "src" / "evals" / "run-single-eval.ts"
BASE_PORT = 6500

MODEL_MAP = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-5",
}

AGENT_MODE_MAP = {
    "haiku": "basic",
    "claude-haiku-4-5": "basic",
    "sonnet": "advanced",
    "claude-sonnet-4-5": "advanced",
}


@dataclass
class WorkerInfo:
    id: int
    port: int
    workspace: str
    process: Optional[subprocess.Popen] = None
    busy: bool = False


class ServerPool:
    """Manages long-lived agent-runtime worker processes."""

    def __init__(self, num_workers: int = 1, model: str = "haiku", base_port: int = BASE_PORT):
        self.num_workers = num_workers
        self.model = model
        self.base_port = base_port
        self.workers: list[WorkerInfo] = []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self):
        """Spawn all workers and wait for them to become healthy."""
        for i in range(self.num_workers):
            w = self._start_worker(i)
            self.workers.append(w)

    def stop(self):
        """Kill all worker processes and clean up workspaces."""
        for w in self.workers:
            self._stop_worker(w)
        self.workers.clear()

    # ------------------------------------------------------------------
    # Prompt injection
    # ------------------------------------------------------------------

    def inject_prompt(self, worker_id: int, overrides: dict) -> dict:
        """POST /agent/prompt-override on a worker to update its system prompt."""
        w = self.workers[worker_id]
        url = f"http://localhost:{w.port}/agent/prompt-override"
        data = json.dumps(overrides).encode()
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def clear_prompt(self, worker_id: int) -> dict:
        """DELETE /agent/prompt-override to reset to default prompts."""
        w = self.workers[worker_id]
        url = f"http://localhost:{w.port}/agent/prompt-override"
        req = urllib.request.Request(url, method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def run_eval(self, worker_id: int, user_message: str, timeout: int = 120) -> dict:
        """Send a message to a worker and return structured metrics.

        Shells out to run-single-eval.ts which handles the SSE parsing.
        Passes --agent-mode (basic/advanced) to control which model the agent uses.

        Returns dict with keys:
            text, toolCalls, stepCount, inputTokens, outputTokens, durationMs, error?
        """
        w = self.workers[worker_id]
        endpoint = f"http://localhost:{w.port}/agent/chat"
        timeout_ms = timeout * 1000
        agent_mode = AGENT_MODE_MAP.get(self.model, "basic")

        try:
            cmd = [
                "bun", "run", str(SINGLE_EVAL),
                "--endpoint", endpoint,
                "--message", user_message,
                "--timeout", str(timeout_ms),
                "--agent-mode", agent_mode,
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout + 30,  # extra buffer for process overhead
                cwd=str(REPO_ROOT),
            )

            for line in result.stdout.strip().splitlines():
                line = line.strip()
                if line.startswith("{"):
                    return json.loads(line)

            return {
                "text": "",
                "toolCalls": [],
                "stepCount": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "durationMs": 0,
                "error": f"No JSON output. exit={result.returncode} stderr={result.stderr[:300]}",
            }

        except subprocess.TimeoutExpired:
            return {
                "text": "",
                "toolCalls": [],
                "stepCount": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "durationMs": timeout * 1000,
                "error": f"Eval timed out after {timeout}s",
            }

    def reset_workspace(self, worker_id: int):
        """Clean workspace and clear prompt overrides between evals."""
        w = self.workers[worker_id]
        self.clear_prompt(worker_id)

        # Clean dynamic-app state and memory between evals
        for subdir in ["memory", "skills"]:
            path = os.path.join(w.workspace, subdir)
            if os.path.exists(path):
                shutil.rmtree(path, ignore_errors=True)
                os.makedirs(path, exist_ok=True)
        for fname in [".canvas-state.json", "MEMORY.md"]:
            path = os.path.join(w.workspace, fname)
            if os.path.exists(path):
                os.remove(path)

    def get_free_worker(self) -> Optional[int]:
        """Return the ID of a non-busy worker, or None."""
        for w in self.workers:
            if not w.busy:
                return w.id
        return None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _start_worker(self, worker_id: int) -> WorkerInfo:
        port = self.base_port + worker_id
        workspace = f"/tmp/dspy-eval-worker-{worker_id}"

        # Clean + create workspace
        if os.path.exists(workspace):
            shutil.rmtree(workspace, ignore_errors=True)
        os.makedirs(workspace, exist_ok=True)
        os.makedirs(os.path.join(workspace, "memory"), exist_ok=True)
        os.makedirs(os.path.join(workspace, "skills"), exist_ok=True)

        # Kill anything on this port
        try:
            subprocess.run(
                f"lsof -ti:{port} | xargs kill -9 2>/dev/null || true",
                shell=True, capture_output=True,
            )
        except Exception:
            pass
        time.sleep(0.5)

        env = {
            **os.environ,
            "PORT": str(port),
            "AGENT_DIR": workspace,
            "PROJECT_DIR": workspace,
            "PROJECT_ID": f"dspy-worker-{worker_id}",
            "NODE_OPTIONS": "--max-old-space-size=512",
        }

        print(f"  [ServerPool] Starting worker {worker_id} on port {port}...")
        stderr_path = os.path.join(workspace, "server-stderr.log")
        stderr_file = open(stderr_path, "w")
        proc = subprocess.Popen(
            ["bun", "run", str(AGENT_SERVER)],
            env=env,
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=stderr_file,
        )

        # Wait for /health
        max_wait = 45
        start = time.time()
        delay = 0.5
        while time.time() - start < max_wait:
            try:
                req = urllib.request.Request(
                    f"http://localhost:{port}/health",
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=3) as resp:
                    if resp.status == 200:
                        elapsed = int((time.time() - start) * 1000)
                        print(f"  [ServerPool] Worker {worker_id} ready on port {port} ({elapsed}ms)")
                        return WorkerInfo(id=worker_id, port=port, workspace=workspace, process=proc)
            except Exception:
                if proc.poll() is not None:
                    stderr_file.close()
                    stderr_content = ""
                    if os.path.exists(stderr_path):
                        with open(stderr_path) as f:
                            stderr_content = f.read()[:500]
                    raise RuntimeError(
                        f"Worker {worker_id} died with exit code {proc.returncode}. "
                        f"stderr: {stderr_content}"
                    )
            time.sleep(delay)
            delay = min(delay * 1.2, 2.0)

        stderr_file.close()
        proc.kill()
        raise RuntimeError(f"Worker {worker_id} failed to start within {max_wait}s")

    def _stop_worker(self, w: WorkerInfo):
        if w.process and w.process.poll() is None:
            w.process.terminate()
            try:
                w.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                w.process.kill()

        # Kill anything remaining on the port
        try:
            subprocess.run(
                f"lsof -ti:{w.port} | xargs kill -9 2>/dev/null || true",
                shell=True, capture_output=True,
            )
        except Exception:
            pass

        # Clean workspace
        if os.path.exists(w.workspace):
            shutil.rmtree(w.workspace, ignore_errors=True)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    model = sys.argv[1] if len(sys.argv) > 1 else "haiku"
    print(f"Testing ServerPool with model={model}")

    pool = ServerPool(num_workers=1, model=model)
    try:
        pool.start()

        # Test prompt injection
        print("\nInjecting prompt override...")
        result = pool.inject_prompt(0, {"canvas_examples": "TEST OVERRIDE"})
        print(f"  Result: {result}")

        # Test eval
        print("\nRunning test eval...")
        result = pool.run_eval(0, "Say hello", timeout=30)
        print(f"  Text: {result.get('text', '')[:200]}")
        print(f"  Tools: {len(result.get('toolCalls', []))}")
        print(f"  Duration: {result.get('durationMs', 0)}ms")
        print(f"  Error: {result.get('error', 'none')}")

        # Test reset
        print("\nResetting workspace...")
        pool.reset_workspace(0)
        print("  Done")

    finally:
        pool.stop()
        print("\nPool stopped.")
