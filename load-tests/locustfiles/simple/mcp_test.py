"""
Simple MCP operations load test.

Scenario 1.3: MCP Tool Operations
- Tests schema and data operations via MCP
- 50-100 concurrent users
- 10 minute duration

Authentication is cookie-based (Better Auth). The Locust client
automatically sends session cookies with each request.
"""
from locust import HttpUser, task, between, events
from locust.contrib.fasthttp import FastHttpUser
import sys
import os
import random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager


class MCPLoadTestUser(FastHttpUser):
    """User that performs MCP tool operations."""

    wait_time = between(2, 5)

    def on_start(self):
        """Authenticate and setup."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        self.authenticated = False
        self.workspace_id = f"ws-{self.user_id}"
        self.schema_name = "task-management"

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.authenticated = True

    def call_mcp_tool(self, tool_name: str, arguments: dict, name: str = None):
        """Call an MCP tool via JSON-RPC (session cookie provides auth)."""
        if not self.authenticated:
            return None

        with self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": random.randint(1, 10000),
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": arguments,
                },
            },
            catch_response=True,
            name=name or f"MCP: {tool_name}",
        ) as response:
            if response.status_code == 200:
                response.success()
                return response.json()
            else:
                response.failure(f"Failed: {response.status_code}")
                return None

    @task(10)
    def list_schemas(self):
        """List available schemas."""
        self.call_mcp_tool(
            "schema.list",
            {"workspace": self.workspace_id},
            name="schema.list",
        )

    @task(8)
    def list_models(self):
        """List entity models in schema."""
        self.call_mcp_tool(
            "store.models",
            {
                "schemaName": self.schema_name,
                "workspace": self.workspace_id,
            },
            name="store.models",
        )

    @task(5)
    def create_entity(self):
        """Create new entity."""
        task_id = random.randint(1, 10000)
        self.call_mcp_tool(
            "store.create",
            {
                "modelName": "Task",
                "data": {
                    "id": f"task-{task_id}",
                    "title": f"Load Test Task {task_id}",
                    "description": "Task created by load test",
                    "status": random.choice(["todo", "in_progress", "done"]),
                    "priority": random.choice(["low", "medium", "high"]),
                },
                "schemaName": self.schema_name,
                "workspace": self.workspace_id,
            },
            name="store.create",
        )

    @task(10)
    def list_entities(self):
        """List entities."""
        self.call_mcp_tool(
            "store.list",
            {
                "modelName": "Task",
                "schemaName": self.schema_name,
                "workspace": self.workspace_id,
                "limit": 10,
            },
            name="store.list",
        )

    @task(3)
    def update_entity(self):
        """Update existing entity."""
        task_id = random.randint(1, 10000)
        self.call_mcp_tool(
            "store.update",
            {
                "modelName": "Task",
                "id": f"task-{task_id}",
                "data": {
                    "status": random.choice(["todo", "in_progress", "done"]),
                },
                "schemaName": self.schema_name,
                "workspace": self.workspace_id,
            },
            name="store.update",
        )

    @task(5)
    def execute_view(self):
        """Execute a query/view."""
        self.call_mcp_tool(
            "view.execute",
            {
                "viewCode": "store.taskCollection.items",
                "schemaName": self.schema_name,
                "workspace": self.workspace_id,
            },
            name="view.execute",
        )


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("Starting MCP operations load test...")
    print(f"Target: {environment.host}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print("MCP operations load test complete")

    stats = environment.stats
    print(f"\nRequests: {stats.total.num_requests}")
    print(f"Failures: {stats.total.num_failures}")
    print(f"Median response time: {stats.total.median_response_time}ms")
    print(f"95th percentile: {stats.total.get_response_time_percentile(0.95)}ms")
    print(f"99th percentile: {stats.total.get_response_time_percentile(0.99)}ms")
