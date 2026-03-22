"""
Simple workspace CRUD load test.

Scenario 1.2: Workspace CRUD Load Test
- Tests database operations under load
- 100-200 concurrent users
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


class WorkspaceLoadTestUser(FastHttpUser):
    """User that performs workspace CRUD operations."""
    
    wait_time = between(2, 5)
    
    def on_start(self):
        """Authenticate user and prepare for workspace operations."""
        self.auth = AuthManager(self.host)
        self._origin = self.host.rstrip("/")
        self._headers = {"Origin": self._origin}
        if config.LOAD_TEST_SECRET:
            self._headers["X-Load-Test-Key"] = config.LOAD_TEST_SECRET
        self.user_id = random.randint(100000, 999999)
        
        # Sign up and login - this sets session cookie automatically
        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.user_id_actual = result.get("userId")
            self.user_name = result.get("userName", "Load Test User")
            self.workspaces = []
            self.projects = []
            self.authenticated = True
            
            # Verify session is working
            session = self.auth.verify_session(self.client)
            if not session:
                print(f"⚠️  Session verification failed for user {self.user_id}")
                self.authenticated = False
        else:
            self.authenticated = False
            print(f"❌ Authentication failed for user {self.user_id}")
    
    @task(10)
    def list_workspaces(self):
        """List all workspaces for authenticated user.
        
        No headers needed - session cookie is sent automatically.
        """
        if not self.authenticated:
            return
        
        # Use v2 API endpoint - session cookie provides authentication
        with self.client.get(
            "/api/workspaces",
            headers=self._headers,
            catch_response=True,
            name="/api/workspaces [LIST]"
        ) as response:
            if response.status_code == 200:
                data = response.json()
                # Update workspace list for other operations
                if isinstance(data, list):
                    self.workspaces = data
                elif isinstance(data, dict) and "items" in data:
                    self.workspaces = data["items"]
                else:
                    self.workspaces = []
                response.success()
            elif response.status_code == 401:
                # Session expired or not authenticated
                response.failure("Unauthorized - session may have expired")
                self.authenticated = False
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(5)
    def create_workspace(self):
        """Create new workspace.
        
        No headers needed - session cookie is sent automatically.
        """
        if not self.authenticated:
            return
        
        workspace_id = random.randint(1000, 9999)
        
        # Use v2 API endpoint - authenticated via session cookie
        with self.client.post(
            "/api/workspaces",
            json={
                "name": f"Load Test WS {workspace_id}",
                "slug": f"loadtest-{workspace_id}",
                "description": "Workspace for load testing"
            },
            headers=self._headers,
            catch_response=True,
            name="/api/workspaces [CREATE]"
        ) as response:
            if response.status_code in [200, 201]:
                workspace = response.json()
                self.workspaces.append(workspace)
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized - session may have expired")
                self.authenticated = False
            elif response.status_code == 400:
                # Validation error (e.g., slug already exists)
                response.success()  # Don't count as failure
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(3)
    def update_workspace(self):
        """Update existing workspace."""
        if not self.authenticated or not self.workspaces:
            return
        
        workspace = random.choice(self.workspaces)
        workspace_id = workspace.get("id")
        
        if not workspace_id:
            return
        
        # Use v2 API endpoint - authenticated via session cookie
        with self.client.patch(
            f"/api/workspaces/{workspace_id}",
            json={
                "name": f"Updated WS {random.randint(1, 1000)}",
                "description": f"Updated at {random.randint(1, 1000)}"
            },
            headers=self._headers,
            catch_response=True,
            name="/api/workspaces/:id [UPDATE]"
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized - session may have expired")
                self.authenticated = False
            elif response.status_code == 404:
                # Workspace might have been deleted
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(8)
    def list_all_projects(self):
        """List all projects for authenticated user.
        
        The API returns all projects the user has access to.
        We can filter client-side by workspace if needed.
        """
        if not self.authenticated:
            return
        
        # Use v2 API endpoint - authenticated via session cookie
        # No workspaceId filter - get all user's projects
        with self.client.get(
            "/api/projects",
            headers=self._headers,
            catch_response=True,
            name="/api/projects [LIST]"
        ) as response:
            if response.status_code == 200:
                data = response.json()
                # Store projects for other operations
                if isinstance(data, dict) and "items" in data:
                    self.projects = data["items"]
                elif isinstance(data, list):
                    self.projects = data
                else:
                    self.projects = []
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized - session may have expired")
                self.authenticated = False
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(4)
    def create_project_in_workspace(self):
        """Create a new project in a workspace."""
        if not self.authenticated or not self.workspaces:
            return
        
        workspace = random.choice(self.workspaces)
        workspace_id = workspace.get("id")
        
        if not workspace_id:
            return
        
        project_id = random.randint(1000, 9999)
        
        # Use v2 API endpoint - authenticated via session cookie
        with self.client.post(
            "/api/projects",
            json={
                "name": f"Load Test Project {project_id}",
                "workspaceId": workspace_id,
                "description": "Project for load testing",
            },
            headers=self._headers,
            catch_response=True,
            name="/api/projects [CREATE]"
        ) as response:
            if response.status_code in [200, 201]:
                data = response.json()
                # Handle response format
                if isinstance(data, dict):
                    project = data.get("item") or data.get("project") or data
                    if self.projects is None:
                        self.projects = []
                    self.projects.append(project)
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized - session may have expired")
                self.authenticated = False
            elif response.status_code == 400:
                # Validation error - don't count as failure
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(2)
    def delete_workspace(self):
        """Delete workspace (cleanup).
        
        Only deletes workspaces we created, not the personal workspace.
        """
        if not self.authenticated or len(self.workspaces) <= 1:
            # Keep at least one workspace (personal workspace)
            return
        
        # Find a workspace we created (not the personal one)
        test_workspaces = [w for w in self.workspaces if "Load Test" in w.get("name", "")]
        if not test_workspaces:
            return
        
        workspace = test_workspaces[0]
        workspace_id = workspace.get("id")
        self.workspaces.remove(workspace)
        
        if not workspace_id:
            return
        
        # Use v2 API endpoint - authenticated via session cookie
        with self.client.delete(
            f"/api/workspaces/{workspace_id}",
            headers=self._headers,
            catch_response=True,
            name="/api/workspaces/:id [DELETE]"
        ) as response:
            if response.status_code in [200, 204]:
                response.success()
            elif response.status_code == 401:
                response.failure("Unauthorized - session may have expired")
                self.authenticated = False
            elif response.status_code == 404:
                # Already deleted
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    """Runs once at the start of the test."""
    print("🚀 Starting workspace CRUD load test...")
    print(f"Target: {environment.host}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    """Runs once at the end of the test."""
    print("✅ Workspace CRUD load test complete")
    
    stats = environment.stats
    print(f"\nRequests: {stats.total.num_requests}")
    print(f"Failures: {stats.total.num_failures}")
    print(f"Median response time: {stats.total.median_response_time}ms")
    print(f"95th percentile: {stats.total.get_response_time_percentile(0.95)}ms")
    print(f"99th percentile: {stats.total.get_response_time_percentile(0.99)}ms")
