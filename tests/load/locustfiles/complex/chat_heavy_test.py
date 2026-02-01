"""
Chat-heavy workload test.

Scenario 2.3: Chat-Heavy Workload
- Stress test project chat proxy and agent servers
- 100 users, 25 projects (4 users per project)
- ~5,000 total chat messages

TODO: Implement full chat-heavy test based on LOAD_TESTING_PLAN.md
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager


class ChatHeavyUser(FastHttpUser):
    """User with heavy chat usage."""
    
    wait_time = between(5, 15)
    
    def on_start(self):
        """Initialize user."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        
        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.token = result["token"]
            self.project_id = None
            self.session_id = f"session-{self.user_id}"
    
    def get_headers(self):
        """Get auth headers."""
        return {"Authorization": f"Bearer {self.token}"}
    
    @task(10)
    def send_chat_message(self):
        """Send chat message to project."""
        if not self.project_id:
            return
        
        messages = [
            "List all users",
            "Create a new task called 'Test task'",
            "Show me all tasks",
            "Update the status of the last task",
            "Generate a report of all tasks"
        ]
        
        with self.client.post(
            f"/api/projects/{self.project_id}/chat",
            headers=self.get_headers(),
            json={
                "message": random.choice(messages),
                "sessionId": self.session_id
            },
            catch_response=True,
            name="/projects/:id/chat [message]"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    # TODO: Add multi-turn conversation logic


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("🚀 Starting chat-heavy workload test...")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("✅ Chat-heavy workload test complete")
