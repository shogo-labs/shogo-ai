"""
Staging CYCLE load test: a fixed pool of projects rotated through a bounded set
of concurrently-active slots, to stress the metal sleep/wake substrate.

Shape (defaults): 80 Locust users (= 80 concurrently-active projects) each own
PROJECTS_PER_USER=5 projects → 400 total. Each user chats MSGS_PER_PROJECT times
on its current project, then rotates to the next one. Leaving a project idles it;
the node-agent suspends it (idle reaper) and the next visit resumes it — from
local NVMe (warm) or Object Storage (cold), exercising:
  - warm-pool assign / cold boot (first touch of a brand-new project)
  - suspend → snapshot (balloon-reclaimed mem) on idle
  - warm local resume + cold S3 resume (ranged GET hydration) on return
  - NVMe cache GC + durable store round-trips under churn

It also drives the whole control plane: API (as chat data-plane proxy) + Postgres
(auth, projects, sessions, usage) + the metal warm-pool controller routing to the
BM host over the mesh.

Targets the Kourier LB over HTTP and replays the __Secure- session cookie as a
Cookie header (Secure cookies aren't sent over http), same as staging_hotpath.

Env:
  LOAD_TEST_SECRET   rate-limit bypass key (must match api-secrets on staging)
  HOST_HEADER        api.shogo-staging-system.staging.shogo.ai
  ORIGIN_OVERRIDE    https://studio.staging.shogo.ai
  CHAT_MODEL         hoshi-1.0 (cheap economy model)
  PROJECTS_PER_USER  projects each VU owns and rotates through (default 5)
  MSGS_PER_PROJECT   messages sent before rotating to the next project (default 3)
"""
import os
import re
import sys
import time
import random

from locust import HttpUser, task, between, events

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))
from locustfiles.common.config import config  # noqa: E402

HOST_HEADER = os.getenv("HOST_HEADER", "")
ORIGIN = os.getenv("ORIGIN_OVERRIDE", "") or (f"https://{HOST_HEADER}" if HOST_HEADER else "")
SECRET = config.LOAD_TEST_SECRET
MODEL = os.getenv("CHAT_MODEL", "hoshi-1.0")
PROJECTS_PER_USER = int(os.getenv("PROJECTS_PER_USER", "5"))
MSGS_PER_PROJECT = int(os.getenv("MSGS_PER_PROJECT", "3"))

COOKIE_RE = re.compile(r"(__Secure-shogo\.[A-Za-z_]+=[^;]+)")

PROMPTS = [
    "Make a simple counter starting at 0 with + and - buttons.",
    "Build a todo list where I can add and remove items. Seed two samples.",
    "Show a small dashboard with users=1500 and revenue=45000.",
    "Add a priority field (low/medium/high) to each todo.",
    "Make a contacts list with name and email; add two examples.",
]


def base_headers():
    h = {}
    if SECRET:
        h["X-Load-Test-Key"] = SECRET
    if HOST_HEADER:
        h["Host"] = HOST_HEADER
    return h


class CycleUser(HttpUser):
    # Pace so a full rotation of a VU's projects takes long enough that the ones
    # it left go idle (node-agent suspends them) before it circles back → the
    # return visit is a real resume, not a still-live hit.
    wait_time = between(2, 5)

    def on_start(self):
        self.cookie = None
        self.workspace_id = None
        self.projects = []          # this VU's fixed project pool
        self.idx = 0                # rotation cursor
        self.msgs_on_current = 0    # messages sent to projects[idx] this visit
        self.arrived = True         # first hit on a project = the wake cost
        self.session_id = f"sess-{random.randint(1,10**9)}"
        if self._signup():
            self._get_workspace()
            for _ in range(PROJECTS_PER_USER):
                pid = self._create_project()
                if pid:
                    self.projects.append(pid)

    # ---- setup helpers ----
    def _signup(self):
        uid = random.randint(config.USER_ID_MIN, config.USER_ID_MAX)
        stamp = int(time.time() * 1000) % 1_000_000
        email = f"{config.TEST_USER_PREFIX}-{uid}-{stamp}@test.shogo.ai"
        with self.client.post(
            "/api/auth/sign-up/email",
            json={"email": email, "password": config.TEST_USER_PASSWORD, "name": f"LT {uid}"},
            headers={**base_headers(), "Origin": ORIGIN},
            catch_response=True,
            name="/api/auth/sign-up/email",
        ) as r:
            if r.status_code == 200:
                pairs = COOKIE_RE.findall(r.headers.get("set-cookie") or "")
                if pairs:
                    self.cookie = "; ".join(pairs)
                r.success()
                return bool(self.cookie)
            r.failure(f"signup {r.status_code}")
            return False

    def _h(self, origin=False):
        h = base_headers()
        if self.cookie:
            h["Cookie"] = self.cookie
        if origin:
            h["Origin"] = ORIGIN
        return h

    def _get_workspace(self):
        with self.client.get("/api/workspaces", headers=self._h(), catch_response=True,
                             name="/api/workspaces") as r:
            if r.status_code == 200:
                try:
                    data = r.json()
                    items = data.get("items", data if isinstance(data, list) else [])
                    if items:
                        self.workspace_id = items[0]["id"]
                    r.success()
                except Exception as e:
                    r.failure(f"parse {e}")
            else:
                r.failure(f"{r.status_code}")

    def _create_project(self):
        if not self.workspace_id:
            return None
        with self.client.post(
            "/api/projects",
            json={"name": f"cycle-{random.randint(1,10**9)}", "workspaceId": self.workspace_id, "type": "AGENT"},
            headers=self._h(origin=True), catch_response=True, name="/api/projects [CREATE]",
        ) as r:
            if r.status_code in (200, 201):
                try:
                    d = r.json()
                    pid = (
                        d.get("data", {}).get("id") or d.get("id")
                        or d.get("project", {}).get("id") or (d.get("item") or {}).get("id")
                    )
                    r.success()
                    return pid
                except Exception as e:
                    r.failure(f"parse {e}")
                    return None
            r.failure(f"{r.status_code}")
            return None

    # ---- rotation hot path ----
    def _ensure_ready(self, pid):
        """On arrival at a project, wait for its runtime (assign / resume) to be
        ready before chatting, so a wake in progress isn't counted as a 503.
        The time here IS the wake cost (cold boot / warm local / cold S3).

        200 = ready. 202 = documented "still starting, retry" (NOT an infra
        error) — the real client polls again, so we retry a few times before
        giving up. Only a hard status (4xx/5xx other than 402) is a failure."""
        start = time.time()
        for attempt in range(6):
            with self.client.get(
                f"/api/projects/{pid}/sandbox/url?wait=true",
                headers=self._h(), catch_response=True, name="/projects/:id/sandbox/url [wake]", timeout=180,
            ) as r:
                if r.status_code == 200:
                    r.success()
                    events.request.fire(request_type="WAKE", name="wake_ready_ms",
                                        response_time=(time.time() - start) * 1000,
                                        response_length=0, exception=None, context={})
                    return True
                if r.status_code == 402:
                    r.success()
                    return True
                if r.status_code == 202:
                    # Retryable per the endpoint contract — count as success and
                    # poll again shortly (chat still guards with its own 503 path).
                    r.success()
                    time.sleep(1.5)
                    continue
                r.failure(f"{r.status_code}")
                return False
        # Exhausted retries while still 202 — proceed to chat, which will
        # surface a real 503 if the runtime genuinely never came up.
        return True

    @task(10)
    def cycle(self):
        if not self.projects:
            return
        pid = self.projects[self.idx]

        if self.arrived:
            if not self._ensure_ready(pid):
                # Wake failed — rotate on so one bad project doesn't wedge the VU.
                self._advance()
                return
            self.arrived = False

        wake = self.msgs_on_current == 0
        label = "/projects/:id/chat [wake]" if wake else "/projects/:id/chat [warm]"
        ttft_label = "chat_ttft [wake]" if wake else "chat_ttft [warm]"
        start = time.time()
        ttft_ms = None
        got = 0
        try:
            with self.client.post(
                f"/api/projects/{pid}/chat",
                json={
                    "messages": [{"role": "user", "parts": [{"type": "text", "text": random.choice(PROMPTS)}]}],
                    "agentMode": MODEL,
                    "chatSessionId": self.session_id,
                },
                headers=self._h(origin=True), catch_response=True, name=label, timeout=150, stream=True,
            ) as r:
                if r.status_code == 200:
                    for chunk in r.iter_content(chunk_size=1):
                        if not chunk:
                            continue
                        if ttft_ms is None:
                            ttft_ms = (time.time() - start) * 1000
                        got += len(chunk)
                    r.success()
                elif r.status_code == 402:
                    r.success()  # usage limit — not an infra fault
                elif r.status_code == 503:
                    r.failure("503 pod_starting (wake miss / not ready)")
                    self._advance()
                    return
                else:
                    r.failure(f"{r.status_code}")
                    self._advance()
                    return
        except Exception as e:
            events.request.fire(request_type="POST", name=label, response_time=(time.time() - start) * 1000,
                                response_length=got, exception=e, context={})
            self._advance()
            return

        if ttft_ms is not None:
            events.request.fire(request_type="TTFT", name=ttft_label, response_time=ttft_ms,
                                response_length=got, exception=None, context={})

        self.msgs_on_current += 1
        if self.msgs_on_current >= MSGS_PER_PROJECT:
            self._advance()

    def _advance(self):
        self.idx = (self.idx + 1) % len(self.projects)
        self.msgs_on_current = 0
        self.arrived = True

    @task(2)
    def status(self):
        if not self.projects:
            return
        pid = self.projects[self.idx]
        with self.client.get(f"/api/projects/{pid}/chat/status",
                             headers=self._h(), catch_response=True,
                             name="/projects/:id/chat/status", timeout=15) as r:
            if r.status_code == 200:
                r.success()
            else:
                r.failure(f"{r.status_code}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    st = environment.stats
    print("\n==== staging_cycle summary ====")
    rows = [
        ("/api/projects [CREATE]", "POST"),
        ("/projects/:id/sandbox/url [wake]", "GET"),
        ("wake_ready_ms", "WAKE"),
        ("chat_ttft [wake]", "TTFT"),
        ("/projects/:id/chat [wake]", "POST"),
        ("chat_ttft [warm]", "TTFT"),
        ("/projects/:id/chat [warm]", "POST"),
        ("/projects/:id/chat/status", "GET"),
    ]
    for name, rtype in rows:
        e = st.get(name, rtype)
        if e and e.num_requests:
            print(f"{name:38s} n={e.num_requests:5d} fail={e.num_failures:4d} "
                  f"med={e.median_response_time:6.0f}ms p95={e.get_response_time_percentile(0.95):6.0f}ms "
                  f"max={e.max_response_time:7.0f}ms")
    t = st.total
    print(f"TOTAL requests={t.num_requests} failures={t.num_failures} "
          f"({(t.num_failures/max(t.num_requests,1))*100:.2f}%) rps={t.total_rps:.1f}")
