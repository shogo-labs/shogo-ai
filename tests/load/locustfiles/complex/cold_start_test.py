"""
Project runtime cold start stress test.

Scenario 2.2: Project Runtime Cold Start Stress Test
- Trigger Knative scaling by accessing many projects simultaneously
- 100 users, 50 projects
- Tests 0→1 replica cold start time

TODO: Implement full cold start test based on LOAD_TESTING_PLAN.md
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager


class ColdStartUser(FastHttpUser):
    """User triggering project cold starts."""
    
    wait_time = between(5, 15)
    
    def on_start(self):
        """Initialize user."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        
        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.token = result["token"]
            self.project_id = None
    
    def get_headers(self):
        """Get auth headers."""
        return {"Authorization": f"Bearer {self.token}"}
    
    @task(10)
    def access_project_chat(self):
        """Access project chat endpoint (triggers cold start)."""
        if not self.project_id:
            return
        
        with self.client.post(
            f"/api/projects/{self.project_id}/chat",
            headers=self.get_headers(),
            json={
                "message": "Hello, what can you do?",
                "sessionId": f"session-{self.user_id}"
            },
            catch_response=True,
            name="/projects/:id/chat [cold-start]"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    # TODO: Add cold start measurement logic


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("🚀 Starting cold start stress test...")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("✅ Cold start stress test complete")
