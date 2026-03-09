"""Authentication utilities for load tests.

Better Auth uses cookie-based sessions, not Bearer tokens.
The Locust HttpSession automatically handles cookies between requests.

The server enforces CSRF protection on state-changing requests (POST/PUT/PATCH/DELETE)
by validating the Origin header. All mutating helpers send an Origin header matching
the target host so requests are not rejected.
"""
import os
from typing import Optional, Dict
import random
import time

from .config import config


class AuthManager:
    """Manages authentication for load test users.
    
    Note: Better Auth uses cookie-based sessions. The Locust client
    automatically maintains cookies, so we just need to track auth state.
    """
    
    def __init__(self, api_base_url: str = None):
        self.api_base_url = api_base_url or config.API_BASE_URL
        self._origin = self._derive_origin(self.api_base_url)
        self.user_data = {}  # user_id -> user data (id, email, name)
        self.signup_attempts = {}  # user_id -> attempt count

    @staticmethod
    def _derive_origin(url: str) -> str:
        """Extract the origin (scheme + host) from a URL for CSRF headers."""
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}"

    def _base_headers(self) -> Dict[str, str]:
        """Return headers included on every request (e.g. rate-limit bypass)."""
        if config.LOAD_TEST_SECRET:
            return {"X-Load-Test-Key": config.LOAD_TEST_SECRET}
        return {}

    def _csrf_headers(self) -> Dict[str, str]:
        """Return headers required to pass CSRF validation."""
        return {**self._base_headers(), "Origin": self._origin}
    
    def generate_test_email(self, user_id: int) -> str:
        """Generate unique test email."""
        return f"{config.TEST_USER_PREFIX}-{user_id}@test.shogo.ai"
    
    def generate_password(self) -> str:
        """Generate password for test user."""
        return config.TEST_USER_PASSWORD
    
    def signup(self, client, user_id: int) -> Optional[Dict]:
        """Sign up a new user via Better Auth.
        
        Better Auth sets session cookies in the response.
        The Locust client automatically stores and sends these cookies.
        If user already exists (422), falls back to sign-in.
        On 500 (DB contention), retries with backoff.
        """
        email = self.generate_test_email(user_id)
        password = self.generate_password()
        
        max_attempts = 5
        for attempt in range(max_attempts):
            with client.post(
                "/api/auth/sign-up/email",
                json={
                    "email": email,
                    "password": password,
                    "name": f"Load Test User {user_id}"
                },
                headers=self._csrf_headers(),
                catch_response=True,
                name="/api/auth/sign-up/email"
            ) as response:
                if response.status_code == 200:
                    data = response.json()
                    user_data = data.get("user", {})
                    if user_data:
                        self.user_data[user_id] = user_data
                        response.success()
                        return {
                            "email": email,
                            "password": password,
                            "userId": user_data.get("id"),
                            "userName": user_data.get("name")
                        }
                elif response.status_code in (403, 422):
                    response.success()
                    return self.login(client, email, password)
                elif response.status_code == 500 and attempt < max_attempts - 1:
                    response.success()
                    delay = (attempt + 1) * 2 + random.random() * 2
                    time.sleep(delay)
                    continue
                elif response.status_code == 429 and attempt < max_attempts - 1:
                    response.success()
                    time.sleep(3 + random.random() * 3)
                    continue
                
                response.failure(f"Signup failed: {response.status_code}")
                return None
        return None
    
    def login(self, client, email: str, password: str) -> Optional[Dict]:
        """Log in existing user via Better Auth.
        
        Better Auth sets session cookies in the response.
        The Locust client automatically stores and sends these cookies.
        """
        # Better Auth uses /api/auth/sign-in/email - sets session cookie automatically
        with client.post(
            "/api/auth/sign-in/email",
            json={"email": email, "password": password},
            headers=self._csrf_headers(),
            catch_response=True,
            name="/api/auth/sign-in/email"
        ) as response:
            if response.status_code == 200:
                data = response.json()
                user_data = data.get("user", {})
                response.success()
                return {
                    "email": email,
                    "password": password,
                    "userId": user_data.get("id"),
                    "userName": user_data.get("name")
                }
            elif response.status_code == 403:
                # Account might not exist, mark as success to avoid noise
                response.success()
                return None
            
            response.failure(f"Login failed: {response.status_code}")
            return None
    
    def get_headers(self, user_id: int = None) -> Dict[str, str]:
        """Get headers for authenticated requests.
        
        With Better Auth's cookie-based sessions, no special headers are needed.
        The Locust client automatically includes session cookies in requests.
        Includes the load-test bypass header when configured.
        """
        return self._base_headers()
    
    def verify_session(self, client) -> Optional[Dict]:
        """Verify current session with server.
        
        This checks if the session cookie is still valid.
        """
        with client.get(
            "/api/auth/get-session",
            headers=self._base_headers(),
            catch_response=True,
            name="/api/auth/get-session"
        ) as response:
            if response.status_code == 200:
                data = response.json()
                response.success()
                return data
            # Session invalid or endpoint not available
            response.success()  # Don't fail on 404/401
            return None
    
    def logout(self, client) -> bool:
        """Log out the current user (clears session cookie)."""
        with client.post(
            "/api/auth/sign-out",
            headers=self._csrf_headers(),
            catch_response=True,
            name="/api/auth/sign-out"
        ) as response:
            if response.status_code == 200:
                response.success()
                return True
            # Logout endpoint might not exist yet
            response.success()  # Don't fail on 404
            return False
