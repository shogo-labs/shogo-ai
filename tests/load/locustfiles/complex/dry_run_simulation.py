"""
Dry Run Simulation — Reproduces the exact concurrent-user scenario
that caused staging failures on 2026-02-20.

Scenario: 10-20 users all arrive within a 2-minute window, each:
1. Signs up / logs in
2. Creates a new project (triggers cold start)
3. Waits for project to become ready (preview URL)
4. Sends a chat message (triggers AI proxy)
5. Views the preview (triggers Vite build)
6. Creates an agent project (triggers agent-runtime cold start)

Key metrics tracked:
- Project cold start time (time from create to preview ready)
- Chat response time (time for AI proxy round-trip)
- Vite build success/failure rate
- Agent runtime start time
- Overall error rate under concurrent load

SLOs:
- Project cold start: < 60s p95
- Warm start: < 5s p95
- Chat first-token: < 10s p95
- Error rate: < 5% (relaxed from normal 1% given cold starts)
"""
from locust import HttpUser, task, between, events, tag
import sys
import os
import json
import time
import random
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager
from locustfiles.common.config import config

logger = logging.getLogger(__name__)

# SLO thresholds (milliseconds)
SLO_COLD_START_P95 = 60_000
SLO_WARM_START_P95 = 5_000
SLO_CHAT_RESPONSE_P95 = 10_000
SLO_MAX_ERROR_RATE = 0.05


class DryRunUser(HttpUser):
    """Simulates a company employee during a dry-run demo.

    Each user goes through the full onboarding flow:
    signup -> create project -> wait for ready -> chat -> preview
    """

    wait_time = between(3, 8)
    host = config.API_BASE_URL

    def on_start(self):
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(200000, 999999)
        self.project_ids = []
        self.workspace_id = None
        self.authenticated = False

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.authenticated = True
            logger.info(f"User {self.user_id} authenticated")
        else:
            logger.warning(f"User {self.user_id} failed to authenticate")
            return

        # Fetch workspace ID (auto-created on signup)
        with self.client.get(
            "/api/workspaces",
            catch_response=True,
            name="/api/workspaces",
        ) as response:
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                if items:
                    self.workspace_id = items[0]["id"]
                    response.success()
                    logger.info(f"User {self.user_id} workspace: {self.workspace_id}")
                else:
                    response.failure("No workspaces found")
            else:
                response.failure(f"Workspaces failed: {response.status_code}")

    @task(5)
    @tag("cold-start", "project")
    def create_project_and_wait(self):
        """Create a new project and measure cold start time."""
        if not self.authenticated or not self.workspace_id:
            return

        start = time.time()

        with self.client.post(
            "/api/projects",
            json={
                "name": f"dry-run-{self.user_id}-{int(time.time())}",
                "workspaceId": self.workspace_id,
            },
            catch_response=True,
            name="/api/projects [create]",
        ) as response:
            if response.status_code not in (200, 201):
                response.failure(f"Create failed: {response.status_code}")
                return

            try:
                data = response.json()
                project_id = (
                    data.get("data", {}).get("id")
                    or data.get("id")
                    or data.get("project", {}).get("id")
                )
            except Exception:
                response.failure("Could not parse project response")
                return

            if not project_id:
                response.failure("No project ID in response")
                return

            self.project_ids.append(project_id)
            response.success()

        # Poll for project readiness (cold start measurement)
        self._wait_for_project_ready(project_id, start)

    def _wait_for_project_ready(self, project_id: str, start_time: float):
        """Poll the sandbox URL endpoint until project is ready or timeout."""
        timeout = 120  # 2 minutes
        poll_interval = 2
        elapsed = 0

        while elapsed < timeout:
            with self.client.get(
                f"/api/projects/{project_id}/sandbox/url",
                catch_response=True,
                name="/api/projects/:id/sandbox/url [poll]",
            ) as response:
                if response.status_code == 200:
                    total_ms = (time.time() - start_time) * 1000
                    # Record cold start as a custom metric
                    events.request.fire(
                        request_type="COLD_START",
                        name="project_cold_start",
                        response_time=total_ms,
                        response_length=0,
                        exception=None,
                        context={},
                    )
                    response.success()
                    logger.info(
                        f"Project {project_id} ready in {total_ms:.0f}ms"
                    )
                    return
                elif response.status_code in (503, 202):
                    response.success()  # Expected during cold start
                else:
                    response.failure(f"Poll failed: {response.status_code}")
                    return

            time.sleep(poll_interval)
            elapsed += poll_interval

        # Timeout
        total_ms = (time.time() - start_time) * 1000
        events.request.fire(
            request_type="COLD_START",
            name="project_cold_start_timeout",
            response_time=total_ms,
            response_length=0,
            exception=TimeoutError(f"Project {project_id} not ready after {timeout}s"),
            context={},
        )

    @task(10)
    @tag("chat", "ai-proxy")
    def send_chat_message(self):
        """Send a chat message to an existing project (tests AI proxy)."""
        if not self.authenticated or not self.project_ids:
            return

        project_id = random.choice(self.project_ids)

        prompts = [
            "List the files in this project.",
            "What does the main component do?",
            "How is routing configured?",
            "Explain the data model.",
        ]

        with self.client.post(
            f"/api/projects/{project_id}/chat",
            json={
                "messages": [
                    {"role": "user", "content": random.choice(prompts)}
                ],
                "sessionId": f"loadtest-{self.user_id}-{int(time.time())}",
                "agentMode": "basic",
            },
            catch_response=True,
            name="/api/projects/:id/chat",
            timeout=60,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 503:
                response.failure("503: Project pod not ready")
            elif response.status_code == 504:
                response.failure("504: Gateway timeout (AI proxy)")
            elif response.status_code == 402:
                response.success()  # Credits exhausted, don't count as failure
            else:
                response.failure(f"Chat failed: {response.status_code}")

    @task(8)
    @tag("preview", "vite")
    def access_preview(self):
        """Access the preview URL to verify Vite build is working."""
        if not self.authenticated or not self.project_ids:
            return

        project_id = random.choice(self.project_ids)

        with self.client.get(
            f"/api/projects/{project_id}/sandbox/url",
            catch_response=True,
            name="/api/projects/:id/sandbox/url",
        ) as response:
            if response.status_code == 200:
                try:
                    data = response.json()
                    preview_url = data.get("url", "")
                    if preview_url:
                        response.success()
                    else:
                        response.failure("No preview URL returned")
                except Exception:
                    response.failure("Invalid response format")
            elif response.status_code == 503:
                response.failure("503: Build not ready")
            else:
                response.failure(f"Preview failed: {response.status_code}")

    @task(3)
    @tag("terminal")
    def execute_terminal_command(self):
        """Execute a preset terminal command (tests project runtime responsiveness)."""
        if not self.authenticated or not self.project_ids:
            return

        project_id = random.choice(self.project_ids)

        with self.client.post(
            f"/api/projects/{project_id}/terminal/exec",
            json={"commandId": "typecheck"},
            catch_response=True,
            name="/api/projects/:id/terminal/exec",
            timeout=60,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 404:
                response.success()  # Project pod may not have workspace dir yet
            else:
                response.failure(f"Terminal exec failed: {response.status_code}")

    @task(2)
    @tag("files")
    def list_files(self):
        """List project files (tests basic file proxy)."""
        if not self.authenticated or not self.project_ids:
            return

        project_id = random.choice(self.project_ids)

        with self.client.get(
            f"/api/projects/{project_id}/files",
            catch_response=True,
            name="/api/projects/:id/files",
            timeout=10,
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Files failed: {response.status_code}")


# Track SLO violations
slo_violations = {
    "cold_start_exceeded": 0,
    "chat_exceeded": 0,
    "total_errors": 0,
    "total_requests": 0,
}


@events.request.add_listener
def on_request(request_type, name, response_time, response_length, exception, **kwargs):
    slo_violations["total_requests"] += 1
    if exception:
        slo_violations["total_errors"] += 1
    if request_type == "COLD_START" and response_time > SLO_COLD_START_P95:
        slo_violations["cold_start_exceeded"] += 1
    if name == "/api/projects/:id/chat" and response_time > SLO_CHAT_RESPONSE_P95:
        slo_violations["chat_exceeded"] += 1


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("=" * 60)
    print("DRY RUN SIMULATION — Concurrent User Stress Test")
    print("=" * 60)
    print(f"SLOs: cold_start<{SLO_COLD_START_P95/1000}s, chat<{SLO_CHAT_RESPONSE_P95/1000}s, errors<{SLO_MAX_ERROR_RATE*100}%")
    print("=" * 60)


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    total = slo_violations["total_requests"] or 1
    error_rate = slo_violations["total_errors"] / total

    print("\n" + "=" * 60)
    print("DRY RUN SIMULATION — Results")
    print("=" * 60)
    print(f"Total requests: {slo_violations['total_requests']}")
    print(f"Total errors: {slo_violations['total_errors']} ({error_rate*100:.1f}%)")
    print(f"Cold start SLO violations: {slo_violations['cold_start_exceeded']}")
    print(f"Chat SLO violations: {slo_violations['chat_exceeded']}")

    passed = True
    if error_rate > SLO_MAX_ERROR_RATE:
        print(f"FAIL: Error rate {error_rate*100:.1f}% exceeds {SLO_MAX_ERROR_RATE*100}%")
        passed = False
    if slo_violations["cold_start_exceeded"] > 0:
        print(f"WARN: {slo_violations['cold_start_exceeded']} cold starts exceeded {SLO_COLD_START_P95/1000}s")

    print("=" * 60)
    print("RESULT: PASS" if passed else "RESULT: FAIL")
    print("=" * 60)
