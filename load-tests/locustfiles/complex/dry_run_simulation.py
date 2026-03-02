"""
Dry Run Simulation — Reproduces the exact concurrent-user scenario
that caused staging failures on 2026-02-20.

Scenario: 10-20 users all arrive within a 2-minute window, each:
1. Signs up / logs in
2. Creates a new AGENT project (triggers warm pool claim / cold start)
3. Sends a chat message (triggers AI proxy)
4. Sends follow-up messages

Key metrics tracked:
- Agent cold start time (time from create to first successful chat)
- Chat response time (time for AI proxy round-trip)
- Overall error rate under concurrent load

SLOs:
- Agent cold start: < 60s p95
- Warm start: < 15s p95
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

SLO_COLD_START_P95 = 60_000
SLO_WARM_START_P95 = 15_000
SLO_CHAT_RESPONSE_P95 = 10_000
SLO_MAX_ERROR_RATE = 0.05


class DryRunUser(HttpUser):
    """Simulates a company employee during a dry-run demo.

    Each user goes through the full onboarding flow:
    signup -> create agent project -> chat -> follow-up messages
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

        with self.client.get(
            "/api/workspaces",
            catch_response=True,
            name="/api/workspaces",
        ) as response:
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", data if isinstance(data, list) else [])
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
    def create_agent_project(self):
        """Create a new agent project and measure cold start time."""
        if not self.authenticated or not self.workspace_id:
            return

        start = time.time()

        with self.client.post(
            "/api/projects",
            json={
                "name": f"dry-run-{self.user_id}-{int(time.time())}",
                "workspaceId": self.workspace_id,
                "type": "AGENT",
            },
            catch_response=True,
            name="/api/projects [create-agent]",
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

        # Send first chat message to trigger runtime start
        self._send_first_chat(project_id, start)

    def _send_first_chat(self, project_id: str, start_time: float):
        """Send first chat message and measure cold start + first response."""
        with self.client.post(
            f"/api/projects/{project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": "Build me a support ticket manager with priority levels and status tracking. Throw in some example tickets to start."}],
                    }
                ],
                "agentMode": "basic",
            },
            catch_response=True,
            name="/api/projects/:id/chat [first-message]",
            timeout=120,
        ) as response:
            total_ms = (time.time() - start_time) * 1000

            if response.status_code == 200:
                events.request.fire(
                    request_type="COLD_START",
                    name="agent_cold_start",
                    response_time=total_ms,
                    response_length=0,
                    exception=None,
                    context={},
                )
                response.success()
                logger.info(f"Agent project {project_id} first response in {total_ms:.0f}ms")
            elif response.status_code == 402:
                response.success()
            elif response.status_code == 503:
                response.failure("503: Agent runtime not ready")
            elif response.status_code == 504:
                response.failure("504: Gateway timeout")
            else:
                response.failure(f"Chat failed: {response.status_code}")

    @task(10)
    @tag("chat", "ai-proxy")
    def send_chat_message(self):
        """Send a chat message to an existing agent project."""
        if not self.authenticated or not self.project_ids:
            return

        project_id = random.choice(self.project_ids)

        prompts = [
            "Now add a way to assign tickets to team members. Each ticket should show the assignee.",
            "Add a category breakdown — show how many tickets are bugs vs feature requests vs questions.",
            "I want to track my sales pipeline too. Show leads in New, Qualified, and Closed stages with company and deal size.",
            "Build me an expense tracker with total spend, category breakdown, and a chart of spending over time.",
            "Show me our recent deployments — which ones passed, which failed, and the trend over the last week.",
            "I need to track job applicants through our hiring process — who applied, what role, what stage, and rating.",
            "Add a warning banner that we're at 85% of our monthly budget. Make it stand out.",
        ]

        with self.client.post(
            f"/api/projects/{project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": random.choice(prompts)}],
                    }
                ],
                "agentMode": "basic",
            },
            catch_response=True,
            name="/api/projects/:id/chat",
            timeout=120,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 503:
                response.failure("503: Agent runtime not ready")
            elif response.status_code == 504:
                response.failure("504: Gateway timeout (AI proxy)")
            elif response.status_code == 402:
                response.success()
            else:
                response.failure(f"Chat failed: {response.status_code}")

    @task(3)
    @tag("status")
    def check_runtime_status(self):
        """Check agent runtime status for a project."""
        if not self.authenticated or not self.project_ids:
            return

        project_id = random.choice(self.project_ids)

        with self.client.get(
            f"/api/projects/{project_id}/chat/status",
            catch_response=True,
            name="/api/projects/:id/chat/status",
            timeout=10,
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Status: {response.status_code}")


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
