"""
Simple authentication load test.

Scenario 1.1: Authentication Load Test
- Tests signup, login, session management
- 50-100 concurrent users
- 5 minute duration
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager


class AuthLoadTestUser(FastHttpUser):
    """User that tests authentication endpoints."""
    
    wait_time = between(1, 3)  # 1-3 seconds between requests
    
    def on_start(self):
        """Initialize user - runs once per user."""
        self.auth = AuthManager(self.host)
        self.user_id = None
        self.email = None
        self.password = None
        self.token = None
    
    @task(3)
    def signup_and_login(self):
        """Sign up new user and immediately log in."""
        # Generate unique user ID
        self.user_id = random.randint(100000, 999999)
        
        # Sign up
        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.email = result["email"]
            self.password = result["password"]
            self.token = result["token"]
    
    @task(5)
    def login_existing(self):
        """Log in with existing credentials."""
        if self.email and self.password:
            token = self.auth.login(self.client, self.email, self.password)
            if token:
                self.token = token
    
    @task(10)
    def get_session(self):
        """Get current session info."""
        if not self.token:
            return
        
        with self.client.get(
            "/api/auth/session",
            headers={"Authorization": f"Bearer {self.token}"},
            catch_response=True
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(2)
    def logout(self):
        """Log out current user."""
        if not self.token:
            return
        
        with self.client.post(
            "/api/auth/logout",
            headers={"Authorization": f"Bearer {self.token}"},
            catch_response=True
        ) as response:
            if response.status_code == 200:
                self.token = None
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    """Runs once at the start of the test."""
    print("🚀 Starting authentication load test...")
    print(f"Target: {environment.host}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    """Runs once at the end of the test."""
    print("✅ Authentication load test complete")
    
    # Print summary statistics
    stats = environment.stats
    print(f"\nRequests: {stats.total.num_requests}")
    print(f"Failures: {stats.total.num_failures}")
    print(f"Median response time: {stats.total.median_response_time}ms")
    print(f"95th percentile: {stats.total.get_response_time_percentile(0.95)}ms")
    print(f"99th percentile: {stats.total.get_response_time_percentile(0.99)}ms")
