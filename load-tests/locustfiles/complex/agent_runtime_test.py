"""
Agent Runtime Load Test — Exercises the agent-runtime pod endpoints
through the API server's agent-proxy.

Targets the full agent runtime surface:
  - Health / status / readiness
  - Workspace file read/write
  - Dynamic app state + SSE stream
  - Dynamic app managed API CRUD (if surface exists)
  - Chat (streaming, LLM round-trip)
  - Webhook ingress
  - Heartbeat trigger
  - Catalog / templates / recipes / skills (read-only)
  - Agent export/import

Each virtual user creates a single agent project and measures the warm
pool assignment pipeline, then hammers the endpoints.

Warm pool flow (expected <15s):
  1. POST /api/projects — create DB record
  2. GET /api/projects/:id/sandbox/url?wait=true — blocks until pod ready
     Internally: claim warm pod → buildProjectEnv (DB provision, AI proxy
     token) → POST /pool/assign → S3 sync → gateway start → return URL

SLOs (from SLOs.md):
  - Agent warm start: < 15s p95
  - Health check: < 2s p99
  - Error rate: < 5%
"""
from locust import HttpUser, task, between, events, tag
import sys
import os
import json
import time
import random
import logging
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from locustfiles.common.auth import AuthManager
from locustfiles.common.config import config

logger = logging.getLogger(__name__)

# SLO thresholds (milliseconds)
SLO_WARM_START_P95 = 15_000
SLO_HEALTH_P99 = 2_000
SLO_ENDPOINT_P95 = 5_000
SLO_CHAT_P95 = 30_000
SLO_MAX_ERROR_RATE = 0.05

# Separate timing buckets for the warm start pipeline
startup_timings = {
    "project_create_ms": [],
    "sandbox_url_ms": [],
    "first_health_ms": [],
    "total_ms": [],
}


class AgentRuntimeUser(HttpUser):
    """Simulates a user interacting with an agent runtime pod.

    Flow:
    1. Authenticate
    2. Create an agent project
    3. Call sandbox/url?wait=true (single blocking call — triggers warm pool claim)
    4. Verify with a health check through agent-proxy
    5. Exercise agent-runtime endpoints
    """

    wait_time = between(1, 4)
    host = config.API_BASE_URL

    def on_start(self):
        self.auth = AuthManager(self.host)
        self._origin = self.host.rstrip("/")
        self._headers = {"Origin": self._origin}
        if config.LOAD_TEST_SECRET:
            self._headers["X-Load-Test-Key"] = config.LOAD_TEST_SECRET
        self.user_id = random.randint(300000, 999999)
        self.project_id = None
        self.agent_proxy_base = None
        self.authenticated = False
        self.pod_ready = False

        result = self.auth.signup(self.client, self.user_id)
        if result:
            self.authenticated = True
            logger.info(f"User {self.user_id} authenticated")
        else:
            logger.warning(f"User {self.user_id} auth failed")
            return

        self._get_workspace()
        if self.workspace_id:
            self._create_and_wait()

    def _get_workspace(self):
        self.workspace_id = None
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
                    items = data.get("items", [])
                    if items:
                        self.workspace_id = items[0]["id"]
                        resp.success()
                        return
                    elif attempt < max_attempts:
                        resp.success()
                        time.sleep(attempt * 0.5)
                        continue
                    else:
                        resp.failure("No workspaces found after retries")
                        return
                elif attempt < max_attempts:
                    resp.success()
                    time.sleep(attempt * 0.5)
                    continue
                else:
                    resp.failure(f"Workspaces: {resp.status_code}")
                    return

    def _create_and_wait(self):
        """Create project + warm pool claim in a single measured pipeline."""
        t_total = time.time()

        # ── Step 1: Create project record ──────────────────────────────
        t0 = time.time()
        with self.client.post(
            "/api/projects",
            json={
                "name": f"agent-load-{self.user_id}-{int(time.time())}",
                "workspaceId": self.workspace_id,
                "type": "AGENT",
            },
            headers=self._headers,
            catch_response=True,
            name="/api/projects [create-agent]",
        ) as resp:
            if resp.status_code not in (200, 201):
                resp.failure(f"Create agent project: {resp.status_code}")
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

        create_ms = (time.time() - t0) * 1000
        startup_timings["project_create_ms"].append(create_ms)
        self.agent_proxy_base = f"/api/projects/{self.project_id}/agent-proxy"

        # ── Step 2: sandbox/url?wait=true (blocks on warm pool claim) ──
        t1 = time.time()
        with self.client.get(
            f"/api/projects/{self.project_id}/sandbox/url?wait=true",
            headers=self._headers,
            catch_response=True,
            name="/api/projects/:id/sandbox/url [wait=true]",
            timeout=120,
        ) as resp:
            sandbox_ms = (time.time() - t1) * 1000
            startup_timings["sandbox_url_ms"].append(sandbox_ms)

            if resp.status_code == 200:
                try:
                    data = resp.json()
                    is_ready = data.get("ready", False)
                    agent_url = data.get("agentUrl")
                    resp.success()

                    if agent_url:
                        logger.info(
                            f"User {self.user_id}: sandbox/url returned agentUrl "
                            f"(ready={is_ready}) in {sandbox_ms:.0f}ms"
                        )
                    else:
                        logger.warning(
                            f"User {self.user_id}: sandbox/url returned 200 but "
                            f"no agentUrl (ready={is_ready}) — might not be an agent project?"
                        )
                except Exception:
                    resp.failure("Could not parse sandbox/url response")
                    return
            else:
                resp.failure(f"sandbox/url: {resp.status_code}")
                return

        # ── Step 3: Verify agent-proxy is reachable ────────────────────
        t2 = time.time()
        with self.client.get(
            f"{self.agent_proxy_base}/health",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/health [first]",
            timeout=10,
        ) as resp:
            health_ms = (time.time() - t2) * 1000
            startup_timings["first_health_ms"].append(health_ms)

            if resp.status_code == 200:
                data = resp.json()
                pool_mode = data.get("poolMode", "unknown")
                uptime = data.get("uptime", "?")
                resp.success()
                self.pod_ready = True
            else:
                resp.failure(f"First health check: {resp.status_code}")
                return

        # ── Step 4: Wait for gateway to be ready (starts in background) ──
        gateway_timeout = 60
        gateway_poll = 2
        gateway_elapsed = 0
        self.gateway_ready = False

        while gateway_elapsed < gateway_timeout:
            with self.client.get(
                f"{self.agent_proxy_base}/agent/status",
                headers=self._headers,
                catch_response=True,
                name="agent-proxy/agent/status [gateway-poll]",
                timeout=5,
            ) as resp:
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("running", False):
                        resp.success()
                        self.gateway_ready = True
                        break
                    resp.success()
                else:
                    resp.success()
            time.sleep(gateway_poll)
            gateway_elapsed += gateway_poll

        if not self.gateway_ready:
            logger.warning(
                f"Gateway not ready after {gateway_timeout}s for {self.project_id}"
            )

        total_ms = (time.time() - t_total) * 1000
        startup_timings["total_ms"].append(total_ms)

        # Fire a custom WARM_START event for locust stats
        events.request.fire(
            request_type="WARM_START",
            name="agent_warm_start",
            response_time=total_ms,
            response_length=0,
            exception=None,
            context={},
        )

        logger.info(
            f"Agent pod ready for {self.project_id}: "
            f"create={create_ms:.0f}ms  sandbox/url={sandbox_ms:.0f}ms  "
            f"health={health_ms:.0f}ms  gateway={'ready' if self.gateway_ready else 'NOT READY'}  "
            f"TOTAL={total_ms:.0f}ms  "
            f"(pod uptime={uptime}s poolMode={pool_mode})"
        )

    # ── Guard ─────────────────────────────────────────────────────────

    def _can_run(self):
        return self.authenticated and self.pod_ready and self.agent_proxy_base

    def _can_chat(self):
        return self._can_run() and self.gateway_ready

    # ── Health & Status (fast, high weight) ───────────────────────────

    @task(15)
    @tag("health")
    def health_check(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/health",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/health",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") == "ok":
                    resp.success()
                else:
                    resp.failure(f"Unexpected health: {data}")
            else:
                resp.failure(f"Health: {resp.status_code}")

    @task(10)
    @tag("status")
    def agent_status(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/status",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/status",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Status: {resp.status_code}")

    @task(5)
    @tag("health")
    def ready_check(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/ready",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/ready",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Ready: {resp.status_code}")

    # ── Workspace File CRUD ───────────────────────────────────────────

    @task(8)
    @tag("files")
    def read_workspace_files(self):
        if not self._can_run():
            return
        files = [
            "AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md",
            "HEARTBEAT.md", "MEMORY.md", "TOOLS.md", "config.json",
        ]
        filename = random.choice(files)
        with self.client.get(
            f"{self.agent_proxy_base}/agent/files/{filename}",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/files/:name [read]",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Read {filename}: {resp.status_code}")

    @task(4)
    @tag("files")
    def write_workspace_file(self):
        if not self._can_run():
            return
        content = f"# Memory\n\nLoad test note at {time.time()}\n"
        with self.client.put(
            f"{self.agent_proxy_base}/agent/files/MEMORY.md",
            json={"content": content},
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/files/:name [write]",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Write MEMORY.md: {resp.status_code}")

    # ── Catalog / Templates / Recipes (read-only) ────────────────────

    @task(3)
    @tag("catalog")
    def get_templates(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/templates",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/templates",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Templates: {resp.status_code}")

    @task(3)
    @tag("catalog")
    def get_recipes(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/recipes",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/recipes",
            timeout=5,
        ) as resp:
            if resp.status_code in (200, 404):
                resp.success()
            else:
                resp.failure(f"Recipes: {resp.status_code}")

    @task(3)
    @tag("catalog")
    def get_bundled_skills(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/bundled-skills",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/bundled-skills",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Bundled skills: {resp.status_code}")

    # ── Dynamic App ──────────────────────────────────────────────────

    @task(8)
    @tag("dynamic-app")
    def get_dynamic_app_state(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/dynamic-app/state",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/dynamic-app/state",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Dynamic app state: {resp.status_code}")

    @task(3)
    @tag("dynamic-app")
    def dynamic_app_action(self):
        if not self._can_run():
            return
        with self.client.post(
            f"{self.agent_proxy_base}/agent/dynamic-app/action",
            json={
                "surfaceId": "load-test",
                "name": "click",
                "context": {"button": "submit"},
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/dynamic-app/action",
            timeout=5,
        ) as resp:
            if resp.status_code in (200, 400):
                resp.success()
            else:
                resp.failure(f"Action: {resp.status_code}")

    # ── Console Logs ─────────────────────────────────────────────────

    @task(4)
    @tag("logs")
    def get_console_logs(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/console-log",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/console-log [read]",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Console logs: {resp.status_code}")

    @task(2)
    @tag("logs")
    def append_console_log(self):
        if not self._can_run():
            return
        with self.client.post(
            f"{self.agent_proxy_base}/console-log/append",
            json={"line": f"[load-test] ping at {time.time()}"},
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/console-log [append]",
            timeout=5,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Console append: {resp.status_code}")

    # ── Export ────────────────────────────────────────────────────────

    @task(2)
    @tag("export")
    def export_agent(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/export",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/export",
            timeout=10,
        ) as resp:
            if resp.status_code == 200:
                data = resp.json()
                if "files" in data:
                    resp.success()
                else:
                    resp.failure("Export missing files key")
            else:
                resp.failure(f"Export: {resp.status_code}")

    # ── Chat History ─────────────────────────────────────────────────

    @task(5)
    @tag("chat")
    def get_chat_history(self):
        if not self._can_run():
            return
        with self.client.get(
            f"{self.agent_proxy_base}/agent/chat/history",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/chat/history",
            timeout=10,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Chat history: {resp.status_code}")

    # ── Chat (streaming, LLM round-trip) ─────────────────────────────

    @task(3)
    @tag("chat", "ai-proxy")
    def send_chat_message_direct(self):
        """Send chat via agent-proxy (direct to pod)."""
        if not self._can_chat():
            return

        prompts = [
            "Build me a todo tracker where I can add, complete, and delete tasks. Seed a few sample items.",
            "I need to see our key business numbers at a glance — we have 1,500 users, $45,000 in revenue, and 342 active sessions.",
            "Build me a contacts list where I can add, edit, and delete people — name, email, phone. Seed a couple entries.",
            "I want to track my sales pipeline. I've got leads in New, Qualified, and Closed stages — show me who's where.",
            "Help me see where my team's money is going this month. We've spent $4,230 of our $6,000 budget. Show me the breakdown.",
            "Build me a support ticket manager with priority levels and status tracking. Throw in some example tickets.",
            "I need to track job applicants through our hiring process — who applied, what role, what stage they're at.",
        ]

        with self.client.post(
            f"{self.agent_proxy_base}/agent/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": random.choice(prompts)}],
                    }
                ],
                "agentMode": "basic",
            },
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/chat",
            timeout=120,
            stream=True,
        ) as resp:
            if resp.status_code == 200:
                got_data = False
                try:
                    for chunk in resp.iter_content(chunk_size=1024):
                        if chunk:
                            got_data = True
                            break
                except Exception as e:
                    resp.failure(f"Stream read error: {e}")
                    return
                if got_data:
                    resp.success()
                else:
                    resp.failure("Empty stream")
            elif resp.status_code == 503:
                resp.failure("503: Gateway not running")
            elif resp.status_code == 402:
                resp.success()
            else:
                resp.failure(f"Chat: {resp.status_code}")

    @task(3)
    @tag("chat", "ai-proxy")
    def send_chat_message_via_api(self):
        """Send chat via API server proxy (exercises billing + proxy pipeline)."""
        if not self._can_chat():
            return

        prompts = [
            "Build me an expense tracker dashboard from some sample data. Show total spend, category breakdown, and a chart.",
            "I want a kanban board for project management with columns for Backlog, In Progress, Review, and Done.",
            "Show me our recent deployments — I want to see which ones passed and which failed, plus the trend over the last week.",
            "Build a CRM for my business — I need to track sales leads with company, contact, deal size, and stage.",
            "Help me track my invoices — client, amount, due date, and whether they're paid. Add a few samples to start.",
            "I need something to help me stay organized with my daily work. Build me a dashboard with tasks, notes, and a calendar view.",
            "Build a quick poll — give people options A and B, and let them pick one. Show results in real-time.",
        ]

        with self.client.post(
            f"/api/projects/{self.project_id}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "parts": [{"type": "text", "text": random.choice(prompts)}],
                    }
                ],
                "agentMode": "basic",
            },
            headers=self._headers,
            catch_response=True,
            name="/api/projects/:id/chat [build]",
            timeout=120,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            elif resp.status_code == 402:
                resp.success()
            elif resp.status_code == 503:
                resp.failure("503: Pod not ready")
            else:
                resp.failure(f"Chat: {resp.status_code}")

    # ── Heartbeat ────────────────────────────────────────────────────

    @task(1)
    @tag("heartbeat")
    def trigger_heartbeat(self):
        if not self._can_chat():
            return
        with self.client.post(
            f"{self.agent_proxy_base}/agent/heartbeat/trigger",
            headers=self._headers,
            catch_response=True,
            name="agent-proxy/agent/heartbeat/trigger",
            timeout=60,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            elif resp.status_code == 503:
                resp.success()
            else:
                resp.failure(f"Heartbeat: {resp.status_code}")


# =============================================================================
# SLO Tracking
# =============================================================================

slo_violations = {
    "warm_start_exceeded": 0,
    "health_exceeded": 0,
    "endpoint_exceeded": 0,
    "chat_exceeded": 0,
    "total_errors": 0,
    "total_requests": 0,
}


@events.request.add_listener
def on_request(request_type, name, response_time, response_length, exception, **kwargs):
    slo_violations["total_requests"] += 1
    if exception:
        slo_violations["total_errors"] += 1

    if request_type == "WARM_START" and response_time > SLO_WARM_START_P95:
        slo_violations["warm_start_exceeded"] += 1
    if "health" in name and response_time > SLO_HEALTH_P99:
        slo_violations["health_exceeded"] += 1
    if "chat" in name and response_time > SLO_CHAT_P95:
        slo_violations["chat_exceeded"] += 1
    if response_time > SLO_ENDPOINT_P95 and "chat" not in name and request_type != "WARM_START":
        slo_violations["endpoint_exceeded"] += 1


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    host = environment.host or config.API_BASE_URL

    # Preflight: check warm pool status
    print("=" * 60)
    print("AGENT RUNTIME LOAD TEST — Preflight")
    print("=" * 60)
    try:
        resp = requests.get(f"{host}/api/warm-pool/status", timeout=5)
        if resp.status_code == 200:
            pool = resp.json()
            avail_agent = pool.get("available", {}).get("agent", "?")
            avail_project = pool.get("available", {}).get("project", "?")
            target_agent = pool.get("targetSize", {}).get("agent", "?")
            assigned = pool.get("assigned", "?")
            enabled = pool.get("enabled", False)
            print(f"  Warm pool enabled: {enabled}")
            print(f"  Agent pods:   {avail_agent}/{target_agent} available")
            print(f"  Project pods: {avail_project}/? available")
            print(f"  Assigned:     {assigned}")
            if not enabled:
                print("  ⚠ WARM POOL DISABLED — expect cold starts!")
            elif avail_agent == 0:
                print("  ⚠ NO WARM AGENT PODS — expect cold starts!")
        else:
            print(f"  Could not check warm pool: HTTP {resp.status_code}")
    except Exception as e:
        print(f"  Could not check warm pool: {e}")

    print("=" * 60)
    print("AGENT RUNTIME LOAD TEST")
    print("=" * 60)
    print(f"SLOs: warm_start<{SLO_WARM_START_P95/1000}s  health<{SLO_HEALTH_P99/1000}s  "
          f"chat<{SLO_CHAT_P95/1000}s  errors<{SLO_MAX_ERROR_RATE*100}%")
    print("=" * 60)


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    total = slo_violations["total_requests"] or 1
    error_rate = slo_violations["total_errors"] / total

    avg = lambda lst: sum(lst) / len(lst) if lst else 0
    p95 = lambda lst: sorted(lst)[int(len(lst) * 0.95)] if lst else 0
    mn = lambda lst: min(lst) if lst else 0
    mx = lambda lst: max(lst) if lst else 0

    print("\n" + "=" * 60)
    print("AGENT RUNTIME LOAD TEST — Results")
    print("=" * 60)
    print(f"Total requests:             {slo_violations['total_requests']}")
    print(f"Total errors:               {slo_violations['total_errors']} ({error_rate*100:.1f}%)")
    print(f"Warm start SLO violations:  {slo_violations['warm_start_exceeded']}")
    print(f"Health SLO violations:      {slo_violations['health_exceeded']}")
    print(f"Endpoint SLO violations:    {slo_violations['endpoint_exceeded']}")
    print(f"Chat SLO violations:        {slo_violations['chat_exceeded']}")

    # Startup timing breakdown
    if startup_timings["total_ms"]:
        n = len(startup_timings["total_ms"])
        print("-" * 60)
        print(f"STARTUP TIMING BREAKDOWN ({n} pods)")
        print(f"  {'':30s} {'avg':>8s} {'p95':>8s} {'min':>8s} {'max':>8s}")
        for label, key in [
            ("1. Project create", "project_create_ms"),
            ("2. sandbox/url (warm claim)", "sandbox_url_ms"),
            ("3. First health check", "first_health_ms"),
            ("TOTAL", "total_ms"),
        ]:
            vals = startup_timings[key]
            if vals:
                print(
                    f"  {label:30s} {avg(vals)/1000:7.1f}s {p95(vals)/1000:7.1f}s "
                    f"{mn(vals)/1000:7.1f}s {mx(vals)/1000:7.1f}s"
                )

    print("-" * 60)

    passed = True
    if error_rate > SLO_MAX_ERROR_RATE:
        print(f"  FAIL: Error rate {error_rate*100:.1f}% > {SLO_MAX_ERROR_RATE*100}%")
        passed = False
    if slo_violations["warm_start_exceeded"] > 0:
        print(f"  FAIL: {slo_violations['warm_start_exceeded']}/{len(startup_timings['total_ms'])} warm starts exceeded {SLO_WARM_START_P95/1000}s SLO")
        passed = False
    if slo_violations["health_exceeded"] > 0:
        print(f"  WARN: {slo_violations['health_exceeded']} health checks exceeded {SLO_HEALTH_P99/1000}s")
    if slo_violations["chat_exceeded"] > 0:
        print(f"  WARN: {slo_violations['chat_exceeded']} chat requests exceeded {SLO_CHAT_P95/1000}s")

    print("=" * 60)
    print("RESULT: PASS" if passed else "RESULT: FAIL")
    print("=" * 60)
