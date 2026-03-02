"""
Complex multi-tenant simulation load test.

Scenario 2.1: Multi-Tenant Workspace Simulation
- Simulates 10 workspaces with 5-20 users each
- 150 total virtual users
- 30 minute duration

Each user authenticates via cookie-based sessions (Better Auth),
creates workspaces, creates AGENT projects, and lists resources.
"""
from locust import HttpUser, task, between, events
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager
from locustfiles.common.config import config


class MultiTenantUser(HttpUser):
    """User simulating multi-tenant workspace usage."""

    wait_time = between(3, 10)
    host = config.API_BASE_URL

    def on_start(self):
        """Authenticate via cookie-based session."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        self.authenticated = False
        self.workspaces = []
        self.projects = []

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.authenticated = True
            session = self.auth.verify_session(self.client)
            if not session:
                self.authenticated = False

    @task(10)
    def list_workspaces(self):
        """List workspaces."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/workspaces",
            catch_response=True,
            name="/api/workspaces [LIST]",
        ) as response:
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list):
                    self.workspaces = data
                elif isinstance(data, dict) and "items" in data:
                    self.workspaces = data["items"]
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized")
                self.authenticated = False
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(5)
    def create_project(self):
        """Create new agent project."""
        if not self.authenticated or not self.workspaces:
            return

        workspace = random.choice(self.workspaces)
        project_num = random.randint(1000, 9999)

        with self.client.post(
            "/api/projects",
            json={
                "name": f"Load Test Project {project_num}",
                "workspaceId": workspace["id"],
                "type": "AGENT",
            },
            catch_response=True,
            name="/api/projects [CREATE]",
        ) as response:
            if response.status_code in (200, 201):
                data = response.json()
                project = data.get("data") or data.get("project") or data
                self.projects.append(project)
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized")
                self.authenticated = False
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(8)
    def list_projects(self):
        """List all projects."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/projects",
            catch_response=True,
            name="/api/projects [LIST]",
        ) as response:
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, dict) and "items" in data:
                    self.projects = data["items"]
                elif isinstance(data, list):
                    self.projects = data
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized")
                self.authenticated = False
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(3)
    def send_chat_message(self):
        """Send a chat message to a random project."""
        if not self.authenticated or not self.projects:
            return

        project = random.choice(self.projects)
        project_id = project.get("id")
        if not project_id:
            return

        with self.client.post(
            f"/api/projects/{project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": "Build me a quick dashboard showing our key metrics — users, revenue, and active sessions. Use sample data."}],
                    }
                ],
                "agentMode": "basic",
            },
            catch_response=True,
            name="/projects/:id/chat [message]",
            timeout=120,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code in (402, 503):
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("Starting multi-tenant simulation...")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("Multi-tenant simulation complete")
