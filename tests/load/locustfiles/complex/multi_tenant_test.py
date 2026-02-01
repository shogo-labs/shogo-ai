"""
Complex multi-tenant simulation load test.

Scenario 2.1: Multi-Tenant Workspace Simulation
- Simulates 10 workspaces with 5-20 users each
- 150 total virtual users
- 30 minute duration

TODO: Implement full multi-tenant simulation based on LOAD_TESTING_PLAN.md
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager


class MultiTenantUser(FastHttpUser):
    """User simulating multi-tenant workspace usage."""
    
    wait_time = between(3, 10)
    
    def on_start(self):
        """Initialize user."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        
        # Sign up and login
        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.token = result["token"]
            self.workspaces = []
            self.projects = []
    
    def get_headers(self):
        """Get auth headers."""
        return {"Authorization": f"Bearer {self.token}"}
    
    @task(10)
    def list_workspaces(self):
        """List workspaces."""
        with self.client.get(
            "/api/workspaces",
            headers=self.get_headers(),
            catch_response=True
        ) as response:
            if response.status_code == 200:
                self.workspaces = response.json()
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(5)
    def create_project(self):
        """Create new project."""
        if not self.workspaces:
            return
        
        workspace = random.choice(self.workspaces)
        project_id = random.randint(1000, 9999)
        
        with self.client.post(
            "/api/projects",
            headers=self.get_headers(),
            json={
                "name": f"Load Test Project {project_id}",
                "workspaceId": workspace["id"],
                "tier": "starter"
            },
            catch_response=True
        ) as response:
            if response.status_code == 200:
                project = response.json()
                self.projects.append(project)
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    # TODO: Add more task implementations based on LOAD_TESTING_PLAN.md


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("🚀 Starting multi-tenant simulation...")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("✅ Multi-tenant simulation complete")
