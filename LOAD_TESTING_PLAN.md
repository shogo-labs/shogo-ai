# Shogo AI - Load Testing Plan

## Executive Summary

This document outlines a comprehensive load testing strategy for the Shogo AI staging infrastructure. It includes both simple baseline tests and complex multi-user, multi-project scenarios to validate scalability.

**Target Environment:** `https://studio-staging.shogo.ai`, `https://api-staging.shogo.ai`

**Key Infrastructure Components:**
- API Server (Hono + Better Auth + Prisma)
- MCP Servers (HTTP transport, per-workspace)
- Project Runtime Pods (Knative, scale-to-zero)
- Databases (PostgreSQL platform + projects, Redis)
- Object Storage (MinIO/S3)

---

## Architecture Overview

### System Components

```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│  ALB Ingress (studio-staging.shogo.ai)
└─────────────┬───────────────────────┘
       │
       ├──────► Web (React SPA)
       │
       ├──────► API Server (8002)
       │          ├── Auth (Better Auth)
       │          ├── Generated CRUD Routes
       │          ├── Project Chat Proxy
       │          ├── File Operations
       │          └── Runtime Manager (local)
       │
       ├──────► MCP Server (3100)
       │          ├── schema.* tools
       │          ├── store.* tools
       │          ├── view.* tools
       │          └── data.* tools
       │
       └──────► Project Runtime Pods (Knative)
                  ├── Vite Dev Server (port)
                  ├── Agent Server (port+1000)
                  └── Auto-scaling 0→N replicas
```

### Critical Paths to Test

1. **Authentication Flow**
   - User signup/login
   - Session management
   - Token refresh

2. **Workspace Operations**
   - Create workspace
   - List workspaces
   - Add members
   - Manage subscriptions

3. **Project Lifecycle**
   - Create project
   - Load schemas
   - CRUD operations on entities
   - Chat with project agent
   - File operations
   - Database queries

4. **Project Runtime Scaling**
   - Cold start (0→1 replica)
   - Warm requests (1→N replicas)
   - Scale down to zero
   - Concurrent project access

5. **MCP Operations**
   - Schema ingestion
   - Entity CRUD via tools
   - Query execution
   - Bulk data loading

---

## Phase 1: Simple Locust Test Plan

### Objectives
- Establish baseline performance metrics
- Identify obvious bottlenecks
- Validate basic API functionality under load

### Test Scenarios

#### Scenario 1.1: Authentication Load Test
**Goal:** Verify auth system can handle concurrent logins
**Duration:** 5 minutes
**Users:** 50 → 100 (ramp up over 2 min)
**Requests per second:** ~50-100 RPS

**User Journey:**
1. Sign up with unique email
2. Log in
3. Get session info
4. Access protected workspace endpoint
5. Log out

**Success Criteria:**
- 95th percentile response time < 500ms for auth endpoints
- 99th percentile < 1s
- Error rate < 0.1%
- No database connection pool exhaustion

#### Scenario 1.2: Workspace CRUD Load Test
**Goal:** Test database operations under load
**Duration:** 10 minutes
**Users:** 100 → 200 (ramp up over 3 min)
**Requests per second:** ~100-200 RPS

**User Journey:**
1. Authenticate
2. List workspaces
3. Create workspace
4. Update workspace
5. List projects in workspace
6. Delete workspace (cleanup)

**Success Criteria:**
- 95th percentile response time < 1s for CRUD ops
- 99th percentile < 2s
- Error rate < 0.5%
- Database query time < 100ms (monitor with logs)

#### Scenario 1.3: MCP Tool Operations
**Goal:** Test schema and data operations via MCP
**Duration:** 10 minutes
**Users:** 50 → 100
**Requests per second:** ~50-100 RPS

**User Journey:**
1. Call `schema.list` to get schemas
2. Call `store.models` to list entity types
3. Call `store.create` to add entities
4. Call `store.list` to query entities
5. Call `view.execute` to run queries

**Success Criteria:**
- 95th percentile < 1s for simple operations
- 95th percentile < 3s for complex queries
- Error rate < 1%
- Schema loading doesn't degrade over time

### Simple Locust Implementation

**File Structure:**
```
tests/load/
├── locustfiles/
│   ├── simple_auth.py
│   ├── simple_workspace.py
│   ├── simple_mcp.py
│   └── common/
│       ├── auth.py
│       └── config.py
├── requirements.txt
└── run_simple_tests.sh
```

**Key Files (see implementation below)**

---

## Phase 2: Complex Multi-User, Multi-Project Test Plan

### Objectives
- Simulate realistic production workload
- Test Knative auto-scaling (project runtimes)
- Validate concurrent chat operations
- Stress test database with realistic data patterns
- Verify resource limits and quotas

### Test Scenarios

#### Scenario 2.1: Multi-Tenant Workspace Simulation
**Goal:** Simulate 10 workspaces with 5-20 users each
**Duration:** 30 minutes
**Total Users:** 150 virtual users
**Workspaces:** 10
**Projects per Workspace:** 5-10
**Total Projects:** ~75 active projects

**Workload Distribution:**
- 40% Project chat interactions
- 30% Entity CRUD operations
- 20% File operations
- 10% Schema/view operations

**User Behaviors:**

**Workspace Admin (10 users, 1 per workspace):**
- Creates projects
- Manages members
- Monitors usage
- Creates/updates schemas
- Configures project settings
- Weight: 2x normal user

**Active Developer (60 users):**
- Opens project
- Chats with AI agent (multi-turn conversations)
- Creates/updates entities
- Runs database queries
- Edits files
- Think time: 3-10 seconds between actions

**Casual User (80 users):**
- Views projects
- Reads data
- Simple queries
- Occasional edits
- Think time: 10-30 seconds

#### Scenario 2.2: Project Runtime Cold Start Stress Test
**Goal:** Trigger Knative scaling by accessing many projects simultaneously
**Duration:** 15 minutes
**Projects:** 50
**Concurrent Access:** 100 users

**Test Phases:**

**Phase 1 - Cold Start Storm (5 min):**
- All 100 users simultaneously access different projects
- Measures 0→1 replica cold start time
- Tests Knative queue-proxy behavior
- Validates runtime manager concurrent start handling

**Phase 2 - Warm Load (5 min):**
- Users continue using their projects
- Tests horizontal scaling (1→N replicas per project)
- Measures response time improvements

**Phase 3 - Scale Down (5 min):**
- Users go idle
- Observe scale to zero behavior
- Validate cleanup and resource release

**Metrics to Track:**
- Cold start P50, P95, P99 latency
- Time to first chat response
- Knative revision creation time
- Pod ready time
- Image pull time (if not pre-pulled)
- Database connection pool saturation

#### Scenario 2.3: Chat-Heavy Workload
**Goal:** Stress test the project chat proxy and agent servers
**Duration:** 20 minutes
**Users:** 100
**Projects:** 25 (4 users per project)
**Chat Messages:** ~5,000 total

**Chat Patterns:**
- Simple queries (50%): "List all users"
- Entity operations (30%): "Create a new task..."
- Complex operations (15%): "Generate a report..."
- Error cases (5%): Invalid requests

**Concurrent Chat Sessions:**
- Each user maintains 1 active chat session
- 2-5 message exchanges per session
- 5-15 second think time between messages

**Success Criteria:**
- Chat response starts within 2s (P95)
- Streaming starts within 500ms (P95)
- No dropped connections
- No database deadlocks
- Proper error handling for concurrent mutations

#### Scenario 2.4: Data-Intensive Operations
**Goal:** Test database and query performance with realistic data volumes
**Duration:** 20 minutes
**Users:** 50
**Projects:** 10
**Entities per Project:** 10,000+ records

**Setup Phase:**
- Pre-populate each project with test data
  - Users: 500
  - Tasks: 5,000
  - Comments: 20,000
  - Relationships fully connected

**Test Operations:**
- Bulk create (batches of 100)
- Complex queries with joins
- Full-text search
- Aggregations
- Updates with cascading relations
- Deletes with integrity checks

**Success Criteria:**
- Bulk operations < 5s for 100 records
- Complex queries < 3s (P95)
- No query timeouts
- Connection pool stable
- No transaction deadlocks

### Complex Test Implementation

**File Structure:**
```
tests/load/
├── locustfiles/
│   ├── complex_multi_tenant.py
│   ├── complex_cold_start.py
│   ├── complex_chat_heavy.py
│   ├── complex_data_intensive.py
│   └── users/
│       ├── workspace_admin.py
│       ├── active_developer.py
│       └── casual_user.py
├── scenarios/
│   ├── project_lifecycle.py
│   ├── chat_conversation.py
│   └── data_operations.py
├── fixtures/
│   ├── seed_data.py
│   └── test_schemas/
│       ├── task_management.json
│       ├── crm.json
│       └── inventory.json
├── requirements.txt
├── setup_test_data.py
└── run_complex_tests.sh
```

---

## Implementation Details

### Directory Structure

```
tests/load/
├── README.md                          # Quick start guide
├── requirements.txt                   # Python dependencies
├── .env.example                       # Environment variables template
├── docker-compose.load-test.yml      # Optional: Run Locust in Docker
├── locustfiles/                      # Test definitions
│   ├── common/
│   │   ├── __init__.py
│   │   ├── auth.py                   # Authentication helpers
│   │   ├── config.py                 # Configuration management
│   │   ├── http_client.py           # Custom HTTP client
│   │   └── metrics.py               # Custom metrics collection
│   ├── simple/
│   │   ├── __init__.py
│   │   ├── auth_test.py             # Scenario 1.1
│   │   ├── workspace_test.py        # Scenario 1.2
│   │   └── mcp_test.py              # Scenario 1.3
│   └── complex/
│       ├── __init__.py
│       ├── multi_tenant_test.py     # Scenario 2.1
│       ├── cold_start_test.py       # Scenario 2.2
│       ├── chat_heavy_test.py       # Scenario 2.3
│       └── data_intensive_test.py   # Scenario 2.4
├── scenarios/                        # Reusable user scenarios
│   ├── __init__.py
│   ├── auth_flow.py
│   ├── workspace_flow.py
│   ├── project_flow.py
│   ├── chat_flow.py
│   └── mcp_flow.py
├── users/                            # Custom user classes
│   ├── __init__.py
│   ├── workspace_admin.py
│   ├── active_developer.py
│   └── casual_user.py
├── fixtures/                         # Test data
│   ├── __init__.py
│   ├── schemas/
│   │   ├── task_management.json
│   │   ├── crm.json
│   │   └── inventory.json
│   └── seed_data/
│       ├── users.json
│       └── projects.json
├── scripts/                          # Automation scripts
│   ├── setup.sh                      # Install dependencies
│   ├── setup_test_data.py           # Pre-populate test data
│   ├── run_simple.sh                # Run simple tests
│   ├── run_complex.sh               # Run complex tests
│   ├── run_all.sh                   # Run full suite
│   ├── cleanup.py                   # Clean up test data
│   └── analyze_results.py           # Parse and analyze results
├── reports/                          # Generated reports (gitignored)
│   └── .gitkeep
└── monitoring/                       # Monitoring dashboards
    ├── grafana_dashboard.json
    └── prometheus_queries.txt
```

---

## Automated Test Execution

### Prerequisites Setup Script

**File: `tests/load/scripts/setup.sh`**

```bash
#!/bin/bash
set -e

echo "Setting up Shogo AI Load Testing Environment..."

# Check Python version
python_version=$(python3 --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
if (( $(echo "$python_version < 3.9" | bc -l) )); then
    echo "Error: Python 3.9+ required"
    exit 1
fi

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Copy environment template
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env file. Please configure with your staging credentials."
fi

# Create reports directory
mkdir -p reports

echo "Setup complete! Activate with: source .venv/bin/activate"
```

### Test Data Setup Script

**File: `tests/load/scripts/setup_test_data.py`**

```python
#!/usr/bin/env python3
"""
Setup script to pre-populate staging environment with test data.

Usage:
    python scripts/setup_test_data.py --env staging --users 100 --workspaces 10
"""
import argparse
import asyncio
import os
import sys
from typing import List, Dict
import httpx
from dotenv import load_dotenv

load_dotenv()

API_BASE_URL = os.getenv("API_BASE_URL", "https://api-staging.shogo.ai")
MCP_BASE_URL = os.getenv("MCP_BASE_URL", "https://mcp-staging.shogo.ai")


class TestDataSeeder:
    """Populates staging with test users, workspaces, and projects."""
    
    def __init__(self, api_url: str, mcp_url: str):
        self.api_url = api_url
        self.mcp_url = mcp_url
        self.admin_token = None
        self.created_users = []
        self.created_workspaces = []
        self.created_projects = []
    
    async def setup(self, num_users: int, num_workspaces: int, projects_per_workspace: int):
        """Main setup flow."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            self.client = client
            
            print(f"\n🚀 Setting up test data...")
            print(f"   Users: {num_users}")
            print(f"   Workspaces: {num_workspaces}")
            print(f"   Projects per workspace: {projects_per_workspace}")
            
            # Step 1: Create test users
            await self._create_users(num_users)
            
            # Step 2: Create workspaces
            await self._create_workspaces(num_workspaces)
            
            # Step 3: Create projects
            await self._create_projects(projects_per_workspace)
            
            # Step 4: Load schemas
            await self._load_schemas()
            
            # Step 5: Seed initial data
            await self._seed_data()
            
            print("\n✅ Test data setup complete!")
            self._print_summary()
    
    async def _create_users(self, count: int):
        """Create test user accounts."""
        print(f"\n📝 Creating {count} test users...")
        
        for i in range(count):
            email = f"loadtest-user-{i}@test.shogo.ai"
            password = "LoadTest123!"
            
            try:
                response = await self.client.post(
                    f"{self.api_url}/api/auth/signup",
                    json={
                        "email": email,
                        "password": password,
                        "name": f"Load Test User {i}"
                    }
                )
                
                if response.status_code == 200:
                    data = response.json()
                    self.created_users.append({
                        "email": email,
                        "password": password,
                        "token": data.get("token"),
                        "userId": data.get("user", {}).get("id")
                    })
                    
                    if i % 10 == 0:
                        print(f"   Created {i}/{count} users")
                
            except Exception as e:
                print(f"   ⚠️  Failed to create user {email}: {e}")
        
        print(f"   ✅ Created {len(self.created_users)} users")
    
    async def _create_workspaces(self, count: int):
        """Create test workspaces."""
        print(f"\n🏢 Creating {count} workspaces...")
        
        for i in range(count):
            # Use first N users as workspace admins
            if i >= len(self.created_users):
                break
            
            user = self.created_users[i]
            
            try:
                response = await self.client.post(
                    f"{self.api_url}/api/workspaces",
                    headers={"Authorization": f"Bearer {user['token']}"},
                    json={
                        "name": f"Load Test Workspace {i}",
                        "slug": f"loadtest-ws-{i}",
                        "description": f"Workspace for load testing"
                    }
                )
                
                if response.status_code == 200:
                    workspace = response.json()
                    self.created_workspaces.append({
                        "id": workspace["id"],
                        "name": workspace["name"],
                        "adminUserId": user["userId"],
                        "adminToken": user["token"]
                    })
            
            except Exception as e:
                print(f"   ⚠️  Failed to create workspace {i}: {e}")
        
        print(f"   ✅ Created {len(self.created_workspaces)} workspaces")
    
    async def _create_projects(self, projects_per_workspace: int):
        """Create test projects in each workspace."""
        print(f"\n🔧 Creating {projects_per_workspace} projects per workspace...")
        
        for ws in self.created_workspaces:
            for i in range(projects_per_workspace):
                try:
                    response = await self.client.post(
                        f"{self.api_url}/api/projects",
                        headers={"Authorization": f"Bearer {ws['adminToken']}"},
                        json={
                            "name": f"Load Test Project {i}",
                            "description": f"Project for load testing",
                            "workspaceId": ws["id"],
                            "tier": "starter",
                            "schemas": []
                        }
                    )
                    
                    if response.status_code == 200:
                        project = response.json()
                        self.created_projects.append({
                            "id": project["id"],
                            "name": project["name"],
                            "workspaceId": ws["id"],
                            "adminToken": ws["adminToken"]
                        })
                
                except Exception as e:
                    print(f"   ⚠️  Failed to create project: {e}")
        
        print(f"   ✅ Created {len(self.created_projects)} projects")
    
    async def _load_schemas(self):
        """Load test schemas into projects."""
        print(f"\n📋 Loading schemas into projects...")
        
        # Simple task management schema
        schema = {
            "name": "task-management",
            "models": {
                "Task": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "x-mst-type": "identifier"},
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "status": {"type": "string", "enum": ["todo", "in_progress", "done"]},
                        "priority": {"type": "string", "enum": ["low", "medium", "high"]}
                    }
                }
            }
        }
        
        for project in self.created_projects[:10]:  # Load schema in first 10 projects
            try:
                response = await self.client.post(
                    f"{self.mcp_url}/mcp",
                    headers={"Authorization": f"Bearer {project['adminToken']}"},
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "schema.set",
                            "arguments": {
                                "schemaName": "task-management",
                                "schema": schema,
                                "workspace": project["workspaceId"]
                            }
                        }
                    }
                )
                
                if response.status_code == 200:
                    project["hasSchema"] = True
            
            except Exception as e:
                print(f"   ⚠️  Failed to load schema: {e}")
        
        print(f"   ✅ Loaded schemas")
    
    async def _seed_data(self):
        """Seed initial data into projects."""
        print(f"\n🌱 Seeding initial data...")
        
        # Create 100 tasks in each project with schema
        for project in [p for p in self.created_projects if p.get("hasSchema")]:
            tasks_created = 0
            
            for i in range(100):
                try:
                    response = await self.client.post(
                        f"{self.mcp_url}/mcp",
                        headers={"Authorization": f"Bearer {project['adminToken']}"},
                        json={
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "tools/call",
                            "params": {
                                "name": "store.create",
                                "arguments": {
                                    "modelName": "Task",
                                    "data": {
                                        "id": f"task-{i}",
                                        "title": f"Task {i}",
                                        "description": f"Test task {i}",
                                        "status": ["todo", "in_progress", "done"][i % 3],
                                        "priority": ["low", "medium", "high"][i % 3]
                                    },
                                    "schemaName": "task-management",
                                    "workspace": project["workspaceId"]
                                }
                            }
                        }
                    )
                    
                    if response.status_code == 200:
                        tasks_created += 1
                
                except Exception as e:
                    if i == 0:  # Only print first error
                        print(f"   ⚠️  Failed to create task: {e}")
            
            project["taskCount"] = tasks_created
        
        print(f"   ✅ Seeded data")
    
    def _print_summary(self):
        """Print summary of created resources."""
        print("\n" + "="*60)
        print("Test Data Summary")
        print("="*60)
        print(f"Users created: {len(self.created_users)}")
        print(f"Workspaces created: {len(self.created_workspaces)}")
        print(f"Projects created: {len(self.created_projects)}")
        print(f"Projects with schemas: {sum(1 for p in self.created_projects if p.get('hasSchema'))}")
        print(f"Total tasks created: {sum(p.get('taskCount', 0) for p in self.created_projects)}")
        print("\nTest Users (first 5):")
        for user in self.created_users[:5]:
            print(f"  - {user['email']} / {user['password']}")
        print("\n⚠️  Save this information for your load tests!")
        print("="*60)


async def main():
    parser = argparse.ArgumentParser(description="Setup Shogo AI load test data")
    parser.add_argument("--env", default="staging", choices=["staging", "local"])
    parser.add_argument("--users", type=int, default=100, help="Number of users to create")
    parser.add_argument("--workspaces", type=int, default=10, help="Number of workspaces")
    parser.add_argument("--projects", type=int, default=5, help="Projects per workspace")
    
    args = parser.parse_args()
    
    if args.env == "staging":
        api_url = "https://api-staging.shogo.ai"
        mcp_url = "https://mcp-staging.shogo.ai"
    else:
        api_url = "http://localhost:8002"
        mcp_url = "http://localhost:3100"
    
    seeder = TestDataSeeder(api_url, mcp_url)
    await seeder.setup(args.users, args.workspaces, args.projects)


if __name__ == "__main__":
    asyncio.run(main())
```

### Requirements File

**File: `tests/load/requirements.txt`**

```txt
# Locust - Load testing framework
locust==2.20.0

# HTTP client
httpx==0.26.0

# Data handling
python-dotenv==1.0.0
faker==22.0.0

# Reporting
pandas==2.1.4
matplotlib==3.8.2
jinja2==3.1.3

# Monitoring
prometheus-client==0.19.0
```

### Environment Template

**File: `tests/load/.env.example`**

```bash
# Target Environment
API_BASE_URL=https://api-staging.shogo.ai
MCP_BASE_URL=https://mcp-staging.shogo.ai
WEB_BASE_URL=https://studio-staging.shogo.ai

# Test Configuration
NUM_USERS=100
SPAWN_RATE=10
RUN_TIME=10m

# Test Credentials (created by setup script)
TEST_USER_PREFIX=loadtest-user
TEST_USER_PASSWORD=LoadTest123!

# Monitoring
PROMETHEUS_URL=http://prometheus-staging.shogo.ai
GRAFANA_URL=http://grafana-staging.shogo.ai

# Thresholds
MAX_RESPONSE_TIME_P95=2000  # ms
MAX_RESPONSE_TIME_P99=5000  # ms
MAX_ERROR_RATE=0.01  # 1%

# Cleanup
CLEANUP_AFTER_TEST=true
```

---

## Simple Locust Tests - Implementation

### Common Auth Helper

**File: `tests/load/locustfiles/common/auth.py`**

```python
"""Authentication utilities for load tests."""
import os
from typing import Optional, Dict
import random
import string

class AuthManager:
    """Manages authentication for load test users."""
    
    def __init__(self, api_base_url: str):
        self.api_base_url = api_base_url
        self.tokens = {}  # user_id -> token
    
    def generate_test_email(self, user_id: int) -> str:
        """Generate unique test email."""
        prefix = os.getenv("TEST_USER_PREFIX", "loadtest-user")
        return f"{prefix}-{user_id}@test.shogo.ai"
    
    def generate_password(self) -> str:
        """Generate random password."""
        return os.getenv("TEST_USER_PASSWORD", "LoadTest123!")
    
    def signup(self, client, user_id: int) -> Optional[Dict]:
        """Sign up a new user."""
        email = self.generate_test_email(user_id)
        password = self.generate_password()
        
        with client.post(
            "/api/auth/signup",
            json={
                "email": email,
                "password": password,
                "name": f"Load Test User {user_id}"
            },
            catch_response=True
        ) as response:
            if response.status_code == 200:
                data = response.json()
                token = data.get("token")
                if token:
                    self.tokens[user_id] = token
                    response.success()
                    return {"email": email, "password": password, "token": token}
            
            response.failure(f"Signup failed: {response.status_code}")
            return None
    
    def login(self, client, email: str, password: str) -> Optional[str]:
        """Log in existing user."""
        with client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
            catch_response=True
        ) as response:
            if response.status_code == 200:
                data = response.json()
                token = data.get("token")
                response.success()
                return token
            
            response.failure(f"Login failed: {response.status_code}")
            return None
    
    def get_headers(self, user_id: int) -> Dict[str, str]:
        """Get authorization headers for user."""
        token = self.tokens.get(user_id)
        if not token:
            return {}
        return {"Authorization": f"Bearer {token}"}
```

### Simple Auth Test

**File: `tests/load/locustfiles/simple/auth_test.py`**

```python
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
        import random
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
```

### Simple Workspace Test

**File: `tests/load/locustfiles/simple/workspace_test.py`**

```python
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


class WorkspaceLoadTestUser(FastHttpUser):
    """User that performs workspace CRUD operations."""
    
    wait_time = between(2, 5)
    
    def on_start(self):
        """Authenticate user."""
        self.auth = AuthManager(self.host)
        self.user_id = random.randint(100000, 999999)
        
        # Sign up and login
        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.token = result["token"]
            self.workspaces = []
    
    def get_headers(self):
        """Get auth headers."""
        return {"Authorization": f"Bearer {self.token}"}
    
    @task(10)
    def list_workspaces(self):
        """List all workspaces."""
        with self.client.get(
            "/api/workspaces",
            headers=self.get_headers(),
            catch_response=True,
            name="/api/workspaces [LIST]"
        ) as response:
            if response.status_code == 200:
                data = response.json()
                self.workspaces = data
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(5)
    def create_workspace(self):
        """Create new workspace."""
        workspace_id = random.randint(1000, 9999)
        
        with self.client.post(
            "/api/workspaces",
            headers=self.get_headers(),
            json={
                "name": f"Load Test WS {workspace_id}",
                "slug": f"loadtest-{workspace_id}",
                "description": "Workspace for load testing"
            },
            catch_response=True,
            name="/api/workspaces [CREATE]"
        ) as response:
            if response.status_code == 200:
                workspace = response.json()
                self.workspaces.append(workspace)
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(3)
    def update_workspace(self):
        """Update existing workspace."""
        if not self.workspaces:
            return
        
        workspace = random.choice(self.workspaces)
        workspace_id = workspace.get("id")
        
        with self.client.patch(
            f"/api/workspaces/{workspace_id}",
            headers=self.get_headers(),
            json={
                "description": f"Updated at {random.randint(1, 1000)}"
            },
            catch_response=True,
            name="/api/workspaces/:id [UPDATE]"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(8)
    def list_projects_in_workspace(self):
        """List projects in a workspace."""
        if not self.workspaces:
            return
        
        workspace = random.choice(self.workspaces)
        workspace_id = workspace.get("id")
        
        with self.client.get(
            f"/api/projects?workspaceId={workspace_id}",
            headers=self.get_headers(),
            catch_response=True,
            name="/api/projects [LIST by workspace]"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
    
    @task(2)
    def delete_workspace(self):
        """Delete workspace (cleanup)."""
        if not self.workspaces:
            return
        
        workspace = self.workspaces.pop()
        workspace_id = workspace.get("id")
        
        with self.client.delete(
            f"/api/workspaces/{workspace_id}",
            headers=self.get_headers(),
            catch_response=True,
            name="/api/workspaces/:id [DELETE]"
        ) as response:
            if response.status_code == 200:
                response.success()
            else:
                response.failure(f"Failed: {response.status_code}")
```

---

## Execution Scripts

### Run Simple Tests

**File: `tests/load/scripts/run_simple.sh`**

```bash
#!/bin/bash
set -e

source .venv/bin/activate

echo "🚀 Running Simple Load Tests..."

# Test 1.1: Authentication (50-100 users, 5 min)
echo "\n📝 Test 1.1: Authentication Load Test"
locust \
    -f locustfiles/simple/auth_test.py \
    --headless \
    --users 100 \
    --spawn-rate 10 \
    --run-time 5m \
    --host https://api-staging.shogo.ai \
    --html reports/auth_test_report.html \
    --csv reports/auth_test

# Test 1.2: Workspace CRUD (100-200 users, 10 min)
echo "\n🏢 Test 1.2: Workspace CRUD Load Test"
locust \
    -f locustfiles/simple/workspace_test.py \
    --headless \
    --users 200 \
    --spawn-rate 20 \
    --run-time 10m \
    --host https://api-staging.shogo.ai \
    --html reports/workspace_test_report.html \
    --csv reports/workspace_test

# Test 1.3: MCP Operations (50-100 users, 10 min)
echo "\n🔧 Test 1.3: MCP Operations Load Test"
locust \
    -f locustfiles/simple/mcp_test.py \
    --headless \
    --users 100 \
    --spawn-rate 10 \
    --run-time 10m \
    --host https://mcp-staging.shogo.ai \
    --html reports/mcp_test_report.html \
    --csv reports/mcp_test

echo "\n✅ Simple tests complete! Check reports/ directory"
```

### Run Complex Tests

**File: `tests/load/scripts/run_complex.sh`**

```bash
#!/bin/bash
set -e

source .venv/bin/activate

echo "🚀 Running Complex Load Tests..."

# Setup test data first
echo "\n📊 Setting up test data..."
python scripts/setup_test_data.py \
    --env staging \
    --users 150 \
    --workspaces 10 \
    --projects 8

# Test 2.1: Multi-Tenant Simulation (150 users, 30 min)
echo "\n🏢 Test 2.1: Multi-Tenant Workspace Simulation"
locust \
    -f locustfiles/complex/multi_tenant_test.py \
    --headless \
    --users 150 \
    --spawn-rate 15 \
    --run-time 30m \
    --host https://api-staging.shogo.ai \
    --html reports/multi_tenant_report.html \
    --csv reports/multi_tenant

# Test 2.2: Cold Start Stress (100 users, 15 min)
echo "\n❄️  Test 2.2: Project Runtime Cold Start Stress Test"
locust \
    -f locustfiles/complex/cold_start_test.py \
    --headless \
    --users 100 \
    --spawn-rate 50 \
    --run-time 15m \
    --host https://api-staging.shogo.ai \
    --html reports/cold_start_report.html \
    --csv reports/cold_start

# Test 2.3: Chat Heavy Workload (100 users, 20 min)
echo "\n💬 Test 2.3: Chat-Heavy Workload"
locust \
    -f locustfiles/complex/chat_heavy_test.py \
    --headless \
    --users 100 \
    --spawn-rate 10 \
    --run-time 20m \
    --host https://api-staging.shogo.ai \
    --html reports/chat_heavy_report.html \
    --csv reports/chat_heavy

# Test 2.4: Data Intensive Operations (50 users, 20 min)
echo "\n📊 Test 2.4: Data-Intensive Operations"
locust \
    -f locustfiles/complex/data_intensive_test.py \
    --headless \
    --users 50 \
    --spawn-rate 5 \
    --run-time 20m \
    --host https://api-staging.shogo.ai \
    --html reports/data_intensive_report.html \
    --csv reports/data_intensive

echo "\n✅ Complex tests complete! Check reports/ directory"
```

### Run All Tests

**File: `tests/load/scripts/run_all.sh`**

```bash
#!/bin/bash
set -e

echo "🚀 Running Full Load Test Suite..."
echo "This will take approximately 2 hours"

# Run simple tests
./scripts/run_simple.sh

# Run complex tests
./scripts/run_complex.sh

# Generate combined report
python scripts/analyze_results.py --all

echo "\n✅ Full test suite complete!"
echo "📊 See reports/combined_report.html for results"
```

---

## Monitoring and Observability

### Key Metrics to Track

**Application Metrics:**
- Request rate (RPS)
- Response times (P50, P95, P99)
- Error rates by endpoint
- Active sessions
- Database connection pool utilization
- Cache hit rates

**Infrastructure Metrics:**
- CPU utilization (API, MCP, project pods)
- Memory usage
- Network I/O
- Disk I/O
- Pod count (Knative)
- Cold start latency

**Database Metrics:**
- Query execution time
- Connection pool size
- Active transactions
- Lock wait time
- Deadlocks
- Replication lag

**Knative Metrics:**
- Revision count
- Scale-from-zero time
- Pod ready time
- Request queue depth
- Concurrency per pod

### Grafana Dashboard

Create dashboard with panels for:

1. **Overview Panel**
   - Total RPS
   - Error rate %
   - P95 latency
   - Active users

2. **API Performance**
   - Request duration by endpoint
   - Error rate by endpoint
   - Database query time

3. **Project Runtimes**
   - Active pods
   - Cold starts
   - Chat request latency

4. **Database Health**
   - Connection pool usage
   - Query performance
   - Transaction rate

5. **Resource Utilization**
   - CPU by service
   - Memory by service
   - Pod count

### Alert Thresholds

**Critical Alerts:**
- Error rate > 5%
- P95 latency > 5s
- Database connection pool > 90%
- Pod failure rate > 10%

**Warning Alerts:**
- Error rate > 1%
- P95 latency > 2s
- Database connection pool > 70%
- Cold start time > 30s

---

## Success Criteria

### Phase 1 - Simple Tests

✅ **Authentication:**
- 100 concurrent users sustained
- P95 < 500ms
- Error rate < 0.1%

✅ **Workspace CRUD:**
- 200 concurrent users sustained
- P95 < 1s
- Error rate < 0.5%
- Database stable

✅ **MCP Operations:**
- 100 concurrent users sustained
- P95 < 3s for complex queries
- Error rate < 1%

### Phase 2 - Complex Tests

✅ **Multi-Tenant:**
- 150 concurrent users across 10 workspaces
- 75 active projects
- P95 < 2s for most operations
- No resource exhaustion

✅ **Cold Start:**
- 50 projects cold start < 30s (P95)
- Knative scales appropriately
- No failed pod creations
- Queue proxy handles bursts

✅ **Chat Heavy:**
- 100 concurrent chat sessions
- Response streaming < 2s (P95)
- No dropped connections
- Agent pods scale 1→N

✅ **Data Intensive:**
- 10K+ entities per project
- Complex queries < 3s (P95)
- No query timeouts
- No deadlocks

---

## Post-Test Analysis

### Automated Analysis Script

**File: `tests/load/scripts/analyze_results.py`**

```python
#!/usr/bin/env python3
"""
Analyzes Locust test results and generates summary report.

Usage:
    python scripts/analyze_results.py --report reports/auth_test_report.html
    python scripts/analyze_results.py --all  # Analyze all reports
"""
import argparse
import pandas as pd
import glob
import os
from pathlib import Path

def analyze_csv(csv_prefix: str):
    """Analyze Locust CSV results."""
    stats_file = f"{csv_prefix}_stats.csv"
    failures_file = f"{csv_prefix}_failures.csv"
    
    if not os.path.exists(stats_file):
        print(f"⚠️  No stats file found: {stats_file}")
        return None
    
    # Load stats
    df = pd.read_csv(stats_file)
    
    # Calculate summary
    summary = {
        "total_requests": df["Request Count"].sum(),
        "total_failures": df["Failure Count"].sum(),
        "error_rate": (df["Failure Count"].sum() / df["Request Count"].sum()) * 100,
        "avg_response_time": df["Average Response Time"].mean(),
        "median_response_time": df["Median Response Time"].mean(),
        "p95_response_time": df["95%"].mean(),
        "p99_response_time": df["99%"].mean(),
        "requests_per_sec": df["Requests/s"].sum()
    }
    
    # Load failures if exists
    if os.path.exists(failures_file):
        failures_df = pd.read_csv(failures_file)
        summary["unique_errors"] = len(failures_df)
    
    return summary

def print_summary(name: str, summary: dict):
    """Print test summary."""
    print(f"\n{'='*60}")
    print(f"{name}")
    print('='*60)
    print(f"Total Requests:      {summary['total_requests']:,}")
    print(f"Total Failures:      {summary['total_failures']:,}")
    print(f"Error Rate:          {summary['error_rate']:.2f}%")
    print(f"Avg Response Time:   {summary['avg_response_time']:.0f}ms")
    print(f"Median Response:     {summary['median_response_time']:.0f}ms")
    print(f"95th Percentile:     {summary['p95_response_time']:.0f}ms")
    print(f"99th Percentile:     {summary['p99_response_time']:.0f}ms")
    print(f"Requests/sec:        {summary['requests_per_sec']:.1f}")
    
    # Pass/Fail checks
    print(f"\n{'Status Checks':}")
    
    checks = []
    
    # Error rate check
    if summary['error_rate'] < 1.0:
        checks.append(("✅", "Error rate < 1%"))
    else:
        checks.append(("❌", f"Error rate too high: {summary['error_rate']:.2f}%"))
    
    # P95 check
    if summary['p95_response_time'] < 2000:
        checks.append(("✅", "P95 response time < 2s"))
    else:
        checks.append(("❌", f"P95 too high: {summary['p95_response_time']:.0f}ms"))
    
    # P99 check
    if summary['p99_response_time'] < 5000:
        checks.append(("✅", "P99 response time < 5s"))
    else:
        checks.append(("❌", f"P99 too high: {summary['p99_response_time']:.0f}ms"))
    
    for status, message in checks:
        print(f"  {status} {message}")

def main():
    parser = argparse.ArgumentParser(description="Analyze load test results")
    parser.add_argument("--report", help="Specific report to analyze")
    parser.add_argument("--all", action="store_true", help="Analyze all reports")
    
    args = parser.parse_args()
    
    if args.all:
        # Find all CSV files in reports/
        csv_files = glob.glob("reports/*_stats.csv")
        
        for csv_file in csv_files:
            csv_prefix = csv_file.replace("_stats.csv", "")
            test_name = Path(csv_prefix).stem
            
            summary = analyze_csv(csv_prefix)
            if summary:
                print_summary(test_name, summary)
    
    elif args.report:
        csv_prefix = args.report.replace(".html", "").replace("_report", "")
        summary = analyze_csv(csv_prefix)
        if summary:
            print_summary(Path(csv_prefix).stem, summary)
    
    else:
        print("Please specify --report or --all")

if __name__ == "__main__":
    main()
```

### Cleanup Script

**File: `tests/load/scripts/cleanup.py`**

```python
#!/usr/bin/env python3
"""
Cleanup script to remove test data from staging environment.

Usage:
    python scripts/cleanup.py --env staging --all
    python scripts/cleanup.py --env staging --users-only
"""
import argparse
import asyncio
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

API_BASE_URL = os.getenv("API_BASE_URL", "https://api-staging.shogo.ai")


async def cleanup_test_data(delete_users: bool = True, delete_workspaces: bool = True):
    """Delete all test data created by load tests."""
    print("🧹 Cleaning up test data...")
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        # TODO: Implement cleanup logic
        # - Delete all users matching loadtest-user-* pattern
        # - Delete all workspaces matching loadtest-ws-* pattern
        # - Delete all projects in those workspaces
        pass
    
    print("✅ Cleanup complete")


async def main():
    parser = argparse.ArgumentParser(description="Cleanup Shogo AI load test data")
    parser.add_argument("--env", default="staging", choices=["staging", "local"])
    parser.add_argument("--all", action="store_true", help="Delete all test data")
    parser.add_argument("--users-only", action="store_true", help="Delete only test users")
    
    args = parser.parse_args()
    
    if args.all:
        await cleanup_test_data(delete_users=True, delete_workspaces=True)
    elif args.users_only:
        await cleanup_test_data(delete_users=True, delete_workspaces=False)


if __name__ == "__main__":
    asyncio.run(main())
```

---

## Next Steps

### Phase 1: Implementation (Week 1-2)

1. **Setup Infrastructure**
   - [ ] Create `tests/load/` directory structure
   - [ ] Install dependencies (`pip install -r requirements.txt`)
   - [ ] Configure `.env` with staging credentials
   - [ ] Test connection to staging environment

2. **Implement Simple Tests**
   - [ ] Implement `auth_test.py`
   - [ ] Implement `workspace_test.py`
   - [ ] Implement `mcp_test.py`
   - [ ] Run smoke test with 10 users

3. **Run Simple Tests**
   - [ ] Execute Test 1.1 (Auth)
   - [ ] Execute Test 1.2 (Workspace CRUD)
   - [ ] Execute Test 1.3 (MCP Operations)
   - [ ] Analyze results and fix critical issues

### Phase 2: Complex Tests (Week 3-4)

1. **Setup Test Data**
   - [ ] Run `setup_test_data.py` to create users/workspaces
   - [ ] Verify data creation
   - [ ] Document test user credentials

2. **Implement Complex Tests**
   - [ ] Implement `multi_tenant_test.py`
   - [ ] Implement `cold_start_test.py`
   - [ ] Implement `chat_heavy_test.py`
   - [ ] Implement `data_intensive_test.py`

3. **Run Complex Tests**
   - [ ] Execute Test 2.1 (Multi-Tenant)
   - [ ] Execute Test 2.2 (Cold Start)
   - [ ] Execute Test 2.3 (Chat Heavy)
   - [ ] Execute Test 2.4 (Data Intensive)
   - [ ] Generate comprehensive report

### Phase 3: Analysis & Optimization (Week 5-6)

1. **Analyze Results**
   - [ ] Identify bottlenecks
   - [ ] Review database query performance
   - [ ] Check Knative scaling behavior
   - [ ] Analyze error patterns

2. **Optimize Infrastructure**
   - [ ] Adjust resource limits
   - [ ] Tune database connection pools
   - [ ] Optimize Knative autoscaling
   - [ ] Implement caching where needed

3. **Re-test**
   - [ ] Run full test suite again
   - [ ] Verify improvements
   - [ ] Update documentation with findings

---

## Appendix

### Useful Commands

```bash
# Run Locust in web UI mode (for debugging)
locust -f locustfiles/simple/auth_test.py --host https://api-staging.shogo.ai

# Run single test with specific parameters
locust -f locustfiles/simple/auth_test.py \
    --headless \
    --users 10 \
    --spawn-rate 2 \
    --run-time 1m \
    --host https://api-staging.shogo.ai

# Monitor Kubernetes pods during test
watch kubectl get pods -n shogo-staging-system
watch kubectl get pods -n shogo-staging-workspaces

# Check Knative services
kubectl get ksvc -n shogo-staging-workspaces

# View API logs
kubectl logs -f deployment/api -n shogo-staging-system

# Check database connections
kubectl exec -it postgres-0 -n shogo-staging-system -- \
    psql -U shogo -c "SELECT count(*) FROM pg_stat_activity;"
```

### Troubleshooting

**Issue: High error rate during tests**
- Check API logs for errors
- Verify database connection pool size
- Check for rate limiting
- Ensure test users are being created properly

**Issue: Slow cold starts**
- Verify image prepuller is running
- Check node resources
- Review Knative autoscaler settings
- Check if images are being pulled from ECR

**Issue: Database connection exhaustion**
- Increase connection pool size
- Check for connection leaks
- Add connection pooler (PgBouncer)
- Review long-running queries

**Issue: Knative pods not scaling**
- Check Knative autoscaler logs
- Verify concurrency settings
- Review resource quotas
- Check for pod scheduling issues

---

## Conclusion

This load testing plan provides comprehensive coverage of the Shogo AI staging infrastructure with:

✅ **Simple baseline tests** - Quick validation of core functionality
✅ **Complex multi-user scenarios** - Realistic production workload simulation
✅ **Automated execution** - Scripts for setup, execution, and analysis
✅ **Detailed monitoring** - Metrics and observability integration
✅ **Clear success criteria** - Measurable goals for each test
✅ **Actionable insights** - Analysis and optimization guidance

The tests are designed to be **fully automated** and can be run on-demand or integrated into CI/CD pipelines.

**Estimated execution time:**
- Simple tests: ~25 minutes
- Complex tests: ~85 minutes
- **Total: ~2 hours**

**Resource Requirements:**
- Python 3.9+
- 2 GB RAM for Locust master
- Staging environment access
- Kubernetes access (for monitoring)

For questions or issues, see the `tests/load/README.md` or contact the platform team.
