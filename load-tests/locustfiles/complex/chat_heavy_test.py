"""
Chat-heavy workload test.

Scenario 2.3: Chat-Heavy Workload
- Stress test project chat proxy and agent servers
- 100 users, 25 projects (4 users per project)
- ~5,000 total chat messages

Each user creates an AGENT project, then sends many chat messages
through the API server's project chat proxy.
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


class ChatHeavyUser(HttpUser):
    """User with heavy chat usage against agent runtimes."""

    wait_time = between(5, 15)
    host = config.API_BASE_URL

    def on_start(self):
        """Authenticate, get workspace, create agent project."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        self.project_id = None
        self.workspace_id = None
        self.authenticated = False
        self.session_id = f"session-{self.user_id}-{int(time.time())}"

        result = self.auth.signup(self.client, self.user_id)
        if not result:
            return
        self.authenticated = True

        # Get workspace
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
                    return
            else:
                resp.failure(f"Workspaces: {resp.status_code}")
                return

        # Create agent project
        with self.client.post(
            "/api/projects",
            json={
                "name": f"chat-heavy-{self.user_id}-{int(time.time())}",
                "workspaceId": self.workspace_id,
                "type": "AGENT",
            },
            catch_response=True,
            name="/api/projects [create-agent]",
        ) as resp:
            if resp.status_code in (200, 201):
                data = resp.json()
                self.project_id = (
                    data.get("data", {}).get("id")
                    or data.get("id")
                    or data.get("project", {}).get("id")
                )
                resp.success()
            else:
                resp.failure(f"Create project: {resp.status_code}")

    @task(10)
    @tag("chat", "ai-proxy")
    def send_chat_message(self):
        """Send chat message to project agent."""
        if not self.authenticated or not self.project_id:
            return

        prompts = [
            "Build me a todo tracker where I can add, complete, and delete tasks. Seed a few sample items.",
            "I need to see our key business numbers — 1,500 users, $45,000 revenue, 342 active sessions. Show me a dashboard.",
            "Build me a contacts list where I can add, edit, and delete people — name, email, phone.",
            "Now update the counter to show 42 instead of 0.",
            "Add a priority field to tasks with values: low, medium, high. Make it filterable.",
            "Show me a sales pipeline with leads in New, Qualified, and Closed stages.",
            "Now make it so I can actually add and delete contacts too. Keep the sample data.",
            "Build an expense tracker with total spend, expense count, and average. Metrics should auto-update.",
            "Add a warning at the top that we're at 85% of budget. Make it stand out — yellow or something.",
            "Help me track my invoices — client, amount, due date, and whether they're paid.",
        ]

        with self.client.post(
            f"/api/projects/{self.project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": random.choice(prompts)}],
                    }
                ],
                "chatSessionId": self.session_id,
                "agentMode": "basic",
            },
            catch_response=True,
            name="/projects/:id/chat [message]",
            timeout=120,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 402:
                response.success()
            elif response.status_code == 503:
                response.failure("503: Pod not ready")
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(3)
    @tag("chat")
    def check_chat_status(self):
        """Check runtime status for project."""
        if not self.authenticated or not self.project_id:
            return

        with self.client.get(
            f"/api/projects/{self.project_id}/chat/status",
            catch_response=True,
            name="/projects/:id/chat/status",
            timeout=10,
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Status: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("Starting chat-heavy workload test...")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("Chat-heavy workload test complete")
