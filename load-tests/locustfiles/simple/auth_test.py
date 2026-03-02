"""
Simple authentication load test.

Scenario 1.1: Authentication Load Test
- Tests signup, login, session management
- 50-100 concurrent users
- 5 minute duration

Better Auth uses cookie-based sessions. The Locust HttpSession
automatically handles cookies between requests.
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager


class AuthLoadTestUser(FastHttpUser):
    """User that tests authentication endpoints via cookie-based sessions."""

    wait_time = between(1, 3)

    def on_start(self):
        """Initialize user."""
        self.auth = AuthManager(self.host)
        self.user_id = None
        self.email = None
        self.password = None
        self.authenticated = False

    @task(3)
    def signup_and_login(self):
        """Sign up new user (sets session cookie automatically)."""
        self.user_id = random.randint(100000, 999999)

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.email = result["email"]
            self.password = result["password"]
            self.authenticated = True

    @task(5)
    def login_existing(self):
        """Log in with existing credentials (refreshes session cookie)."""
        if self.email and self.password:
            result = self.auth.login(self.client, self.email, self.password)
            if result:
                self.authenticated = True

    @task(10)
    def get_session(self):
        """Verify current session via cookie."""
        if not self.authenticated:
            return

        session = self.auth.verify_session(self.client)
        if not session:
            self.authenticated = False

    @task(2)
    def logout(self):
        """Log out current user (clears session cookie)."""
        if not self.authenticated:
            return

        if self.auth.logout(self.client):
            self.authenticated = False


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("Starting authentication load test...")
    print(f"Target: {environment.host}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("Authentication load test complete")

    stats = environment.stats
    print(f"\nRequests: {stats.total.num_requests}")
    print(f"Failures: {stats.total.num_failures}")
    print(f"Median response time: {stats.total.median_response_time}ms")
    print(f"95th percentile: {stats.total.get_response_time_percentile(0.95)}ms")
    print(f"99th percentile: {stats.total.get_response_time_percentile(0.99)}ms")
