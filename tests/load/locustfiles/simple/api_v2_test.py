"""
Simple API v2 endpoint load test.

Tests the working v2 API endpoints without authentication.
This tests the actual endpoints we observed working in production.

- Tests GET endpoints that return data
- 50-100 concurrent users
- 10 minute duration
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))


class APIv2LoadTestUser(FastHttpUser):
    """User that tests v2 API endpoints (read-only operations)."""
    
    wait_time = between(2, 5)
    
    def on_start(self):
        """Initialize user."""
        # We'll test public/read endpoints that don't require auth
        # or use a test user token if available
        self.test_workspace_id = "f48645c0-0cfa-4b1c-ba0b-f792ee07a866"  # From network trace
        self.test_user_id = "cc47f0d1-436b-49ed-8b05-046c51380e86"  # From network trace
    
    @task(10)
    def get_auth_session(self):
        """Get auth session (public endpoint)."""
        with self.client.get(
            "/api/auth/get-session",
            catch_response=True,
            name="/api/auth/get-session"
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
            catch_response=True,
            name="/api/templates"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(5)
    def list_workspaces(self):
        """List workspaces for test user."""
        with self.client.get(
            f"/api/v2/workspaces?userId={self.test_user_id}",
            catch_response=True,
            name="/api/v2/workspaces"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(5)
    def list_projects(self):
        """List projects in workspace."""
        with self.client.get(
            f"/api/v2/projects?workspaceId={self.test_workspace_id}",
            catch_response=True,
            name="/api/v2/projects"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(3)
    def list_folders(self):
        """List folders in workspace."""
        with self.client.get(
            f"/api/v2/folders?workspaceId={self.test_workspace_id}",
            catch_response=True,
            name="/api/v2/folders"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(3)
    def list_starred_projects(self):
        """List starred projects."""
        with self.client.get(
            f"/api/v2/starred-projects?userId={self.test_user_id}",
            catch_response=True,
            name="/api/v2/starred-projects"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(2)
    def list_members(self):
        """List workspace members."""
        with self.client.get(
            f"/api/v2/members?userId={self.test_user_id}",
            catch_response=True,
            name="/api/v2/members"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("🚀 Starting API v2 load test...")
    print(f"Target: {environment.host}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("✅ API v2 load test complete")
    
    stats = environment.stats
    print(f"\nRequests: {stats.total.num_requests}")
    print(f"Failures: {stats.total.num_failures}")
    print(f"Median response time: {stats.total.median_response_time}ms")
    print(f"95th percentile: {stats.total.get_response_time_percentile(0.95)}ms")
    print(f"99th percentile: {stats.total.get_response_time_percentile(0.99)}ms")
