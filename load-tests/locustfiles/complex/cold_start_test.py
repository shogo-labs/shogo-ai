"""
Agent runtime cold start stress test.

Scenario 2.2: Cold Start Stress Test
- Trigger Knative scaling by accessing many agent projects simultaneously
- 100 users, 50 projects
- Tests 0->1 replica cold start time

Each user creates an AGENT project and immediately sends a chat message,
measuring how long it takes for the pod to become ready and respond.
"""
from locust import HttpUser, task, between, events, tag
import sys
import os
import random
import time
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager
from locustfiles.common.config import config

logger = logging.getLogger(__name__)


class ColdStartUser(HttpUser):
    """User triggering agent runtime cold starts."""

    wait_time = between(5, 15)
    host = config.API_BASE_URL

    def on_start(self):
        """Authenticate and get workspace."""
        self.auth = AuthManager(self.host)
        self._origin = self.host.rstrip("/")
        self.user_id = random.randint(100000, 999999)
        self.project_id = None
        self.workspace_id = None
        self.authenticated = False

        result = self.auth.signup(self.client, self.user_id)
        if not result:
            return
        self.authenticated = True

        with self.client.get(
            "/api/workspaces",
            catch_response=True,
            name="/api/workspaces",
        ) as resp:
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("items", data if isinstance(data, list) else [])
                if items:
                    self.workspace_id = items[0]["id"]
                    resp.success()
                else:
                    resp.failure("No workspaces")
            else:
                resp.failure(f"Workspaces: {resp.status_code}")

    @task(10)
    @tag("cold-start", "project")
    def create_project_and_chat(self):
        """Create new agent project and immediately send a chat message (triggers cold start)."""
        if not self.authenticated or not self.workspace_id:
            return

        start = time.time()

        # Create agent project
        with self.client.post(
            "/api/projects",
            json={
                "name": f"cold-start-{self.user_id}-{int(time.time())}",
                "workspaceId": self.workspace_id,
                "type": "AGENT",
            },
            headers={"Origin": self._origin},
            catch_response=True,
            name="/api/projects [create-agent-cold-start]",
        ) as resp:
            if resp.status_code not in (200, 201):
                resp.failure(f"Create: {resp.status_code}")
                return
            try:
                data = resp.json()
                project_id = (
                    data.get("data", {}).get("id")
                    or data.get("id")
                    or data.get("project", {}).get("id")
                )
            except Exception:
                resp.failure("Could not parse response")
                return
            if not project_id:
                resp.failure("No project ID")
                return
            resp.success()

        self.project_id = project_id

        # Send chat message (triggers cold start of agent runtime)
        with self.client.post(
            f"/api/projects/{project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": "Build me a quick todo tracker with a couple sample items. Make sure it actually works."}],
                    }
                ],
                "agentMode": "basic",
            },
            headers={"Origin": self._origin},
            catch_response=True,
            name="/projects/:id/chat [cold-start]",
            timeout=120,
        ) as response:
            total_ms = (time.time() - start) * 1000

            if response.status_code == 200:
                response.success()
                events.request.fire(
                    request_type="COLD_START",
                    name="agent_cold_start",
                    response_time=total_ms,
                    response_length=0,
                    exception=None,
                    context={},
                )
                logger.info(f"Agent cold start for {project_id}: {total_ms:.0f}ms")
            elif response.status_code == 402:
                response.success()
            elif response.status_code == 503:
                response.failure("503: Pod not ready")
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(5)
    @tag("chat")
    def chat_existing_project(self):
        """Send message to already-created project (warm path)."""
        if not self.authenticated or not self.project_id:
            return

        with self.client.post(
            f"/api/projects/{self.project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": "Now add a priority field to each task — low, medium, high. Make it filterable."}],
                    }
                ],
                "agentMode": "basic",
            },
            headers={"Origin": self._origin},
            catch_response=True,
            name="/projects/:id/chat [warm]",
            timeout=60,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 402:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("Starting cold start stress test...")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("Cold start stress test complete")
