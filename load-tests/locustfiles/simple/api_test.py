"""
Simple API endpoint load test.

Tests the core API endpoints with authentication.
- Tests GET endpoints that return data (workspaces, projects, templates, etc.)
- 50-100 concurrent users
- 10 minute duration
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager
from locustfiles.common.config import config


class APILoadTestUser(FastHttpUser):
    """User that tests core API endpoints (authenticated via session cookies)."""

    wait_time = between(2, 5)

    def on_start(self):
        """Authenticate user."""
        self.auth = AuthManager(self.host)
        self._headers = {}
        if config.LOAD_TEST_SECRET:
            self._headers["X-Load-Test-Key"] = config.LOAD_TEST_SECRET
        self.user_id = random.randint(100000, 999999)
        self.authenticated = False
        self.workspaces = []

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.authenticated = True
            session = self.auth.verify_session(self.client)
            if not session:
                self.authenticated = False

    @task(10)
    def get_auth_session(self):
        """Get auth session."""
        with self.client.get(
            "/api/auth/get-session",
            headers=self._headers,
            catch_response=True,
            name="/api/auth/get-session",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(8)
    def get_templates(self):
        """Get templates list."""
        with self.client.get(
            "/api/templates",
            headers=self._headers,
            catch_response=True,
            name="/api/templates",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(5)
    def list_workspaces(self):
        """List workspaces for authenticated user."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/workspaces",
            headers=self._headers,
            catch_response=True,
            name="/api/workspaces",
        ) as response:
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list):
                    self.workspaces = data
                elif isinstance(data, dict) and "items" in data:
                    self.workspaces = data["items"]
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(5)
    def list_projects(self):
        """List projects."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/projects",
            headers=self._headers,
            catch_response=True,
            name="/api/projects",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(3)
    def list_folders(self):
        """List folders."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/folders",
            headers=self._headers,
            catch_response=True,
            name="/api/folders",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(3)
    def list_starred_projects(self):
        """List starred projects."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/starred-projects",
            headers=self._headers,
            catch_response=True,
            name="/api/starred-projects",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(2)
    def list_members(self):
        """List workspace members."""
        if not self.authenticated:
            return

        with self.client.get(
            "/api/members",
            headers=self._headers,
            catch_response=True,
            name="/api/members",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")

    @task(2)
    def health_check(self):
        """API health check (public endpoint)."""
        with self.client.get(
            "/api/health",
            headers=self._headers,
            catch_response=True,
            name="/api/health",
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("Starting API load test...")
    print(f"Target: {environment.host}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("API load test complete")

    stats = environment.stats
    print(f"\nRequests: {stats.total.num_requests}")
    print(f"Failures: {stats.total.num_failures}")
    print(f"Median response time: {stats.total.median_response_time}ms")
    print(f"95th percentile: {stats.total.get_response_time_percentile(0.95)}ms")
    print(f"99th percentile: {stats.total.get_response_time_percentile(0.99)}ms")
