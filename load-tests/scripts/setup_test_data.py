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

# Uses the API DomainMapping directly (not the studio proxy) for external tooling
API_BASE_URL = os.getenv("API_BASE_URL", "https://api-staging.shogo.ai")


class TestDataSeeder:
    """Populates staging with test users, workspaces, and projects."""
    
    def __init__(self, api_url: str):
        self.api_url = api_url
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
            
            # Step 4: Load schemas (optional - commenting out for now)
            # await self._load_schemas()
            
            # Step 5: Seed initial data (optional - commenting out for now)
            # await self._seed_data()
            
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
                    
                    if i % 10 == 0 and i > 0:
                        print(f"   Created {i}/{count} users")
                
            except Exception as e:
                if i == 0:
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
                if i == 0:
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
                    if i == 0:
                        print(f"   ⚠️  Failed to create project: {e}")
        
        print(f"   ✅ Created {len(self.created_projects)} projects")
    
    def _print_summary(self):
        """Print summary of created resources."""
        print("\n" + "="*60)
        print("Test Data Summary")
        print("="*60)
        print(f"Users created: {len(self.created_users)}")
        print(f"Workspaces created: {len(self.created_workspaces)}")
        print(f"Projects created: {len(self.created_projects)}")
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
    else:
        api_url = "http://localhost:8002"
    
    seeder = TestDataSeeder(api_url)
    await seeder.setup(args.users, args.workspaces, args.projects)


if __name__ == "__main__":
    asyncio.run(main())
