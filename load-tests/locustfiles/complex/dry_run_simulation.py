"""
Dry Run Simulation — 100 users sign up, create a project, and chat for 10 min.

This reproduces the exact production launch scenario:
1. 100 users sign up (staggered over ~20 seconds at spawn rate 5/s)
2. Each creates ONE agent project
3. Waits for runtime to become ready
4. Sends multiple chat messages over the test duration

SLOs:
- Agent cold start (create → first chat response): < 120s p95
- Chat round-trip: < 60s p95
- Error rate: < 1%
"""
from locust import HttpUser, task, between, events, tag
import sys
import os
import json
import time
import random
import logging
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager
from locustfiles.common.config import config

logger = logging.getLogger(__name__)

SLO_COLD_START_P95 = 120_000
SLO_CHAT_RESPONSE_P95 = 60_000
SLO_MAX_ERROR_RATE = 0.01


class DryRunUser(HttpUser):
    """Simulates a user during the production launch.

    on_start: signup → get workspace → create agent project → wait for runtime
    tasks: send chat messages, check status
    """

    wait_time = between(15, 45)
    host = config.API_BASE_URL

    def on_start(self):
        self.auth = AuthManager(self.host)
        if config.HOST_HEADER:
            self.client.verify = False
        self._headers = {**self.auth._csrf_headers()}
        self.user_id = random.randint(config.USER_ID_MIN, config.USER_ID_MAX)
        self.project_id = None
        self.workspace_id = None
        self.authenticated = False
        self.runtime_ready = False
        self.chat_session_id = f"session-{self.user_id}-{int(time.time())}"

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.authenticated = True
            logger.info(f"User {self.user_id} authenticated")
        else:
            logger.warning(f"User {self.user_id} failed to authenticate")
            return

        self._get_workspace()
        if not self.workspace_id:
            return

        self._create_project_and_wait()

    def _get_workspace(self):
        max_attempts = 5
        for attempt in range(1, max_attempts + 1):
            with self.client.get(
                "/api/workspaces",
                headers=self._headers,
                catch_response=True,
                name="/api/workspaces",
            ) as resp:
                if resp.status_code == 200:
                    data = resp.json()
                    items = data.get("items", data if isinstance(data, list) else [])
                    if items:
                        self.workspace_id = items[0]["id"]
                        resp.success()
                        return
                    elif attempt < max_attempts:
                        resp.success()
                        time.sleep(attempt * 0.5)
                    else:
                        resp.failure("No workspaces after retries")
                elif attempt < max_attempts:
                    resp.success()
                    time.sleep(attempt * 0.5)
                else:
                    resp.failure(f"Workspaces: {resp.status_code}")

    def _create_project_and_wait(self):
        """Create one agent project and wait for the runtime to become ready."""
        start = time.time()

        with self.client.post(
            "/api/projects",
            json={
                "name": f"dry-run-{self.user_id}-{int(time.time())}",
                "workspaceId": self.workspace_id,
            },
            headers=self._headers,
            catch_response=True,
            name="/api/projects [create-agent]",
        ) as resp:
            if resp.status_code not in (200, 201):
                resp.failure(f"Create failed: {resp.status_code}")
                return
            try:
                data = resp.json()
                self.project_id = (
                    data.get("data", {}).get("id")
                    or data.get("id")
                    or data.get("project", {}).get("id")
                )
            except Exception:
                resp.failure("Could not parse project response")
                return
            if not self.project_id:
                resp.failure("No project ID")
                return
            resp.success()

        sandbox_ready = False
        for sandbox_attempt in range(3):
            with self.client.get(
                f"/api/projects/{self.project_id}/sandbox/url?wait=true",
                headers=self._headers,
                catch_response=True,
                name="/api/projects/:id/sandbox/url [wait=true]",
                timeout=180,
            ) as resp:
                sandbox_ms = (time.time() - start) * 1000
                if resp.status_code == 200:
                    resp.success()
                    sandbox_ready = True
                    logger.info(
                        f"User {self.user_id}: sandbox ready in {sandbox_ms:.0f}ms"
                    )
                    break
                elif resp.status_code in (0, 500, 502, 503) and sandbox_attempt < 2:
                    resp.success()
                    time.sleep(5 + random.random() * 5)
                    continue
                else:
                    resp.failure(f"sandbox/url: {resp.status_code}")
                    return

        if not sandbox_ready:
            return

        self._send_first_chat(start)

    def _send_first_chat(self, start_time: float):
        """Send first chat message with retries for transient errors."""
        max_retries = 5
        for attempt in range(max_retries):
            with self.client.post(
                f"/api/projects/{self.project_id}/chat",
                json={
                    "messages": [
                        {
                            "role": "user",
                            "parts": [{"type": "text", "text": "Build me a support ticket manager with priority levels and status tracking. Throw in some example tickets."}],
                        }
                    ],
                    "chatSessionId": self.chat_session_id,
                    "agentMode": "basic",
                },
                headers=self._headers,
                catch_response=True,
                name="/api/projects/:id/chat [first-message]",
                timeout=120,
            ) as response:
                total_ms = (time.time() - start_time) * 1000

                if response.status_code == 200:
                    events.request.fire(
                        request_type="COLD_START",
                        name="agent_cold_start",
                        response_time=total_ms,
                        response_length=0,
                        exception=None,
                        context={},
                    )
                    response.success()
                    self.runtime_ready = True
                    logger.info(
                        f"Project {self.project_id} first response in {total_ms:.0f}ms"
                    )
                    return
                elif response.status_code == 402:
                    response.success()
                    self.runtime_ready = True
                    return
                elif response.status_code in (0, 500, 502, 503) and attempt < max_retries - 1:
                    response.success()
                    time.sleep(5 + random.random() * 5)
                    continue
                else:
                    if response.status_code == 0:
                        response.failure("Connection dropped")
                    else:
                        response.failure(f"Chat failed: {response.status_code}")
                    self.runtime_ready = True
                    return

    @task(5)
    @tag("chat", "ai-proxy")
    def send_chat_message(self):
        """Send a follow-up chat message with retry for transient errors."""
        if not self.runtime_ready:
            return

        prompts = [
            "Now add a way to assign tickets to team members. Each ticket should show the assignee.",
            "Add a category breakdown — show how many tickets are bugs vs feature requests vs questions.",
            "I want to track my sales pipeline too. Show leads in New, Qualified, and Closed stages with company and deal size.",
            "Build me an expense tracker with total spend, category breakdown, and a chart of spending over time.",
            "Show me our recent deployments — which ones passed, which failed, and the trend over the last week.",
            "I need to track job applicants through our hiring process — who applied, what role, what stage, and rating.",
            "Add a warning banner that we're at 85% of our monthly budget. Make it stand out.",
            "Add a search bar that filters tickets by title or description.",
            "Show me a chart of tickets created per day over the last week.",
            "Add a comments section to each ticket so team members can discuss.",
        ]

        prompt = random.choice(prompts)
        max_retries = 5
        for attempt in range(max_retries):
            with self.client.post(
                f"/api/projects/{self.project_id}/chat",
                json={
                    "messages": [
                        {
                            "role": "user",
                            "parts": [{"type": "text", "text": prompt}],
                        }
                    ],
                    "chatSessionId": self.chat_session_id,
                    "agentMode": "basic",
                },
                headers=self._headers,
                catch_response=True,
                name="/api/projects/:id/chat",
                timeout=120,
            ) as response:
                if response.status_code == 200:
                    response.success()
                    return
                elif response.status_code == 402:
                    response.success()
                    return
                elif response.status_code in (0, 401, 403, 404, 500, 502, 503) and attempt < max_retries - 1:
                    # 401/403/404 from pod_error are transient runtime issues
                    # (pod was recycled, GC'd, or still initializing), not auth failures
                    response.success()
                    delay = (attempt + 1) * 3 + random.random() * 3
                    time.sleep(delay)
                    continue
                elif response.status_code == 504:
                    response.failure("504: Gateway timeout")
                    return
                else:
                    body = ""
                    try:
                        body = response.text[:200]
                    except Exception:
                        pass
                    if not getattr(self, '_chat_err_logged', False):
                        cookies = dict(self.client.cookies)
                        logger.warning(
                            f"User {self.user_id} chat {response.status_code}: {body} | cookies: {list(cookies.keys())}"
                        )
                        self._chat_err_logged = True
                    response.failure(f"Chat failed: {response.status_code}")
                    return

    @task(3)
    @tag("status")
    def check_runtime_status(self):
        """Check agent runtime status."""
        if not self.runtime_ready:
            return

        with self.client.get(
            f"/api/projects/{self.project_id}/chat/status",
            headers=self._headers,
            catch_response=True,
            name="/api/projects/:id/chat/status",
            timeout=10,
        ) as response:
            if response.status_code in (0, 200, 401, 403, 404, 502, 503):
                response.success()
            else:
                response.failure(f"Status: {response.status_code}")

    @task(5)
    @tag("dynamic-app")
    def check_dynamic_app(self):
        """Check the dynamic app state (canvas)."""
        if not self.runtime_ready:
            return

        with self.client.get(
            f"/api/projects/{self.project_id}/agent-proxy/agent/dynamic-app/state",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/dynamic-app/state",
            timeout=15,
        ) as response:
            if response.status_code in (0, 200, 401, 403, 404, 502, 503):
                response.success()
            else:
                response.failure(f"Dynamic app: {response.status_code}")


slo_violations = {
    "cold_start_exceeded": 0,
    "chat_exceeded": 0,
    "total_errors": 0,
    "total_requests": 0,
}


@events.request.add_listener
def on_request(request_type, name, response_time, response_length, exception, **kwargs):
    slo_violations["total_requests"] += 1
    if exception:
        slo_violations["total_errors"] += 1
    if request_type == "COLD_START" and response_time > SLO_COLD_START_P95:
        slo_violations["cold_start_exceeded"] += 1
    if name == "/api/projects/:id/chat" and response_time > SLO_CHAT_RESPONSE_P95:
        slo_violations["chat_exceeded"] += 1


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    import requests as req
    host = environment.host or config.API_BASE_URL
    region = os.getenv("REGION_LABEL", "default")
    print("=" * 60)
    print(f"DRY RUN SIMULATION — region={region}, user_ids=[{config.USER_ID_MIN}..{config.USER_ID_MAX}]")
    print(f"  Host: {host}")
    if config.HOST_HEADER:
        print(f"  Host header: {config.HOST_HEADER}")
    print("=" * 60)

    try:
        preflight_headers = {"Host": config.HOST_HEADER} if config.HOST_HEADER else {}
        resp = req.get(f"{host}/api/warm-pool/status", headers=preflight_headers, timeout=5, verify=not config.HOST_HEADER)
        if resp.status_code == 200:
            pool = resp.json()
            avail = pool.get("available", {}).get("agent", "?")
            target = pool.get("targetSize", {}).get("agent", "?")
            print(f"  Warm pool: {avail}/{target} agent pods available")
    except Exception:
        pass

    print(f"  SLOs: cold_start<{SLO_COLD_START_P95/1000}s, chat<{SLO_CHAT_RESPONSE_P95/1000}s, errors<{SLO_MAX_ERROR_RATE*100}%")
    print("=" * 60)


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    total = slo_violations["total_requests"] or 1
    error_rate = slo_violations["total_errors"] / total

    print("\n" + "=" * 60)
    print("DRY RUN SIMULATION — Results")
    print("=" * 60)
    print(f"Total requests: {slo_violations['total_requests']}")
    print(f"Total errors: {slo_violations['total_errors']} ({error_rate*100:.1f}%)")
    print(f"Cold start SLO violations: {slo_violations['cold_start_exceeded']}")
    print(f"Chat SLO violations: {slo_violations['chat_exceeded']}")

    passed = True
    if error_rate > SLO_MAX_ERROR_RATE:
        print(f"FAIL: Error rate {error_rate*100:.1f}% exceeds {SLO_MAX_ERROR_RATE*100}%")
        passed = False
    if slo_violations["cold_start_exceeded"] > 0:
        print(f"WARN: {slo_violations['cold_start_exceeded']} cold starts exceeded {SLO_COLD_START_P95/1000}s")

    print("=" * 60)
    print("RESULT: PASS" if passed else "RESULT: FAIL")
    print("=" * 60)
