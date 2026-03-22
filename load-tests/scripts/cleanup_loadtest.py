#!/usr/bin/env python3
"""
Post-load-test cleanup — deletes all users, projects, and workspaces
created by the load test scripts.

Authenticates as a super admin, then uses the admin API to:
  1. Find all users matching the load test prefix
  2. Delete each user's project pods (Knative services + PVCs)
  3. Delete users (cascades to DB records for sessions, accounts, etc.)

When targeting a direct region IP, use --host-header to set the Host header
so Knative routes the request correctly.

Usage:
  python scripts/cleanup_loadtest.py
  python scripts/cleanup_loadtest.py --host https://152.70.192.220 --host-header studio.shogo.ai
  python scripts/cleanup_loadtest.py --prefix loadtest-user --dry-run
"""
import argparse
import os
import sys
import time
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from locustfiles.common.config import config


def parse_args():
    parser = argparse.ArgumentParser(description="Clean up load test users and projects")
    parser.add_argument(
        "--host",
        default=os.getenv("CLEANUP_HOST", "http://localhost:8002"),
        help="API host (default: $CLEANUP_HOST or http://localhost:8002)",
    )
    parser.add_argument(
        "--host-header",
        default=os.getenv("HOST_HEADER", ""),
        help="Host header override (for direct IP targets, e.g. studio.shogo.ai)",
    )
    parser.add_argument(
        "--prefix",
        default=os.getenv("TEST_USER_PREFIX", config.TEST_USER_PREFIX),
        help="Test user email prefix to search for (default: loadtest-user)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be deleted without actually deleting",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="Page size for admin list queries (max 100)",
    )
    return parser.parse_args()


class AdminSession:
    """Authenticated admin session for cleanup operations."""

    def __init__(self, host: str, host_header: str = ""):
        self.host = host.rstrip("/")
        self.session = requests.Session()
        self.session.verify = not bool(host_header)
        origin = f"https://{host_header}" if host_header else self.host
        self.session.headers.update({
            "Content-Type": "application/json",
            "Origin": origin,
        })
        if host_header:
            self.session.headers["Host"] = host_header
        if config.LOAD_TEST_SECRET:
            self.session.headers["X-Load-Test-Key"] = config.LOAD_TEST_SECRET

    def login(self, email: str, password: str) -> bool:
        resp = self.session.post(
            f"{self.host}/api/auth/sign-in/email",
            json={"email": email, "password": password},
        )
        if resp.status_code == 200:
            data = resp.json()
            user = data.get("user", {})
            print(f"  Authenticated as {user.get('email')} (id={user.get('id')})")
            return True
        print(f"  ERROR: Login failed: {resp.status_code} {resp.text[:200]}")
        return False

    def list_users(self, search: str, page: int = 1, limit: int = 100):
        resp = self.session.get(
            f"{self.host}/api/admin/users",
            params={"search": search, "page": page, "limit": limit, "orderBy": "createdAt", "order": "asc"},
        )
        if resp.status_code != 200:
            print(f"  ERROR: List users failed: {resp.status_code}")
            return [], 0
        data = resp.json().get("data", {})
        return data.get("users", []), data.get("total", 0)

    def list_projects(self, search: str, page: int = 1, limit: int = 100):
        resp = self.session.get(
            f"{self.host}/api/admin/projects",
            params={"search": search, "page": page, "limit": limit, "orderBy": "createdAt", "order": "asc"},
        )
        if resp.status_code != 200:
            print(f"  ERROR: List projects failed: {resp.status_code}")
            return [], 0
        data = resp.json().get("data", {})
        return data.get("projects", []), data.get("total", 0)

    def delete_project_pod(self, project_id: str) -> bool:
        """Delete Knative service + PVCs for a project.

        DELETE /api/admin/projects/:id hits the custom route which calls
        knative-project-manager.deleteProject().
        """
        resp = self.session.delete(f"{self.host}/api/admin/projects/{project_id}")
        if resp.status_code == 200:
            return True
        if resp.status_code == 404 or resp.status_code == 400:
            return True
        print(f"    WARN: Pod delete for {project_id}: {resp.status_code}")
        return False

    def delete_user(self, user_id: str) -> bool:
        """Delete user DB record (cascades to sessions, accounts, memberships)."""
        resp = self.session.delete(f"{self.host}/api/admin/users/{user_id}")
        if resp.status_code == 200:
            return True
        print(f"    WARN: User delete {user_id}: {resp.status_code} {resp.text[:100]}")
        return False

    def delete_workspace(self, workspace_id: str) -> bool:
        resp = self.session.delete(f"{self.host}/api/admin/workspaces/{workspace_id}")
        if resp.status_code == 200:
            return True
        print(f"    WARN: Workspace delete {workspace_id}: {resp.status_code} {resp.text[:100]}")
        return False


def paginate_all(list_fn, search: str, batch_size: int = 100):
    """Fetch all items across pages."""
    all_items = []
    page = 1
    while True:
        items, total = list_fn(search, page=page, limit=batch_size)
        all_items.extend(items)
        if len(all_items) >= total or not items:
            break
        page += 1
    return all_items


def main():
    args = parse_args()
    host = args.host
    prefix = args.prefix
    dry_run = args.dry_run
    batch_size = min(args.batch_size, 100)

    admin_email = config.ADMIN_EMAIL or os.getenv("ADMIN_EMAIL", "")
    admin_password = config.ADMIN_PASSWORD or os.getenv("ADMIN_PASSWORD", "")

    if not admin_email or not admin_password:
        print("ERROR: ADMIN_EMAIL and ADMIN_PASSWORD must be set (in .env or as env vars)")
        sys.exit(1)

    host_header = args.host_header

    print("=" * 60)
    print(f"  Load Test Cleanup{' (DRY RUN)' if dry_run else ''}")
    print("=" * 60)
    print(f"  Host:        {host}")
    if host_header:
        print(f"  Host header: {host_header}")
    print(f"  Prefix:      {prefix}")
    print("=" * 60)
    print()

    admin = AdminSession(host, host_header=host_header)

    print("Authenticating as admin...")
    if not admin.login(admin_email, admin_password):
        sys.exit(1)
    print()

    # ---- Step 1: Find all load test users ----
    print(f"Finding users matching '{prefix}'...")
    users = paginate_all(admin.list_users, prefix, batch_size)
    # Filter to only those whose email matches the load test pattern
    users = [u for u in users if u.get("email", "").startswith(f"{prefix}-") and u["email"].endswith("@test.shogo.ai")]
    print(f"  Found {len(users)} load test users")
    print()

    if not users:
        print("Nothing to clean up.")
        return

    # ---- Step 2: Find all load test projects ----
    # Search for projects with "dry-run" prefix (created by dry_run_simulation)
    # and also by createdBy matching user IDs
    print("Finding load test projects...")
    projects = paginate_all(admin.list_projects, "dry-run", batch_size)
    # Also search for other load test project name patterns
    for pattern in ["cold-start", "chat-heavy", "agent-load", "Load Test Project"]:
        extra = paginate_all(admin.list_projects, pattern, batch_size)
        seen_ids = {p["id"] for p in projects}
        for p in extra:
            if p["id"] not in seen_ids:
                projects.append(p)

    # Filter to only projects owned by load test users
    user_ids = {u["id"] for u in users}
    lt_projects = [p for p in projects if p.get("createdBy") in user_ids]
    print(f"  Found {len(lt_projects)} projects owned by load test users (out of {len(projects)} matched)")
    print()

    if dry_run:
        print("DRY RUN — would delete:")
        print(f"  {len(lt_projects)} project pods + DB records")
        print(f"  {len(users)} users (+ cascaded sessions, accounts, memberships)")
        print()
        print("Users:")
        for u in users[:20]:
            print(f"  - {u['email']} (id={u['id']})")
        if len(users) > 20:
            print(f"  ... and {len(users) - 20} more")
        print()
        print("Projects:")
        for p in lt_projects[:20]:
            print(f"  - {p.get('name', 'unnamed')} (id={p['id']})")
        if len(lt_projects) > 20:
            print(f"  ... and {len(lt_projects) - 20} more")
        return

    # ---- Step 3: Delete project pods (K8s resources) ----
    print(f"Deleting {len(lt_projects)} project pods...")
    pod_ok = 0
    pod_fail = 0
    for i, proj in enumerate(lt_projects):
        pid = proj["id"]
        if admin.delete_project_pod(pid):
            pod_ok += 1
        else:
            pod_fail += 1
        if (i + 1) % 10 == 0:
            print(f"  ... {i + 1}/{len(lt_projects)} pods processed")
    print(f"  Pods deleted: {pod_ok}, failed: {pod_fail}")
    print()

    # Small delay to let K8s resources settle
    if lt_projects:
        time.sleep(2)

    # ---- Step 4: Delete users (cascades to DB records) ----
    print(f"Deleting {len(users)} users...")
    user_ok = 0
    user_fail = 0
    for i, user in enumerate(users):
        uid = user["id"]
        if admin.delete_user(uid):
            user_ok += 1
        else:
            user_fail += 1
        if (i + 1) % 10 == 0:
            print(f"  ... {i + 1}/{len(users)} users processed")
    print(f"  Users deleted: {user_ok}, failed: {user_fail}")
    print()

    # ---- Summary ----
    print("=" * 60)
    print("  Cleanup Summary")
    print("=" * 60)
    print(f"  Project pods:  {pod_ok} deleted, {pod_fail} failed")
    print(f"  Users:         {user_ok} deleted, {user_fail} failed")
    total_fail = pod_fail + user_fail
    if total_fail > 0:
        print(f"  WARNING: {total_fail} operations failed — some resources may need manual cleanup")
    else:
        print("  All resources cleaned up successfully")
    print("=" * 60)


if __name__ == "__main__":
    main()
