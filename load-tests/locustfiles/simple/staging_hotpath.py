"""
Staging HOT PATH load test: project creation -> warm-pool assignment
(Object Storage hydration) -> agent chat proxied through the API.

This targets the app's real bottleneck (not auth): the warm pool + runtime
assignment and the API-as-data-plane-proxy chat path. Uses the hoshi-1.0
(mimo-v2.5, economy) model so LLM round-trips are cheap.

Targets the Kourier LB over HTTP; captures the __Secure- session cookie from
sign-up and replays it as a Cookie header (Secure cookies aren't sent over http).

Env:
  LOAD_TEST_SECRET  rate-limit bypass key
  HOST_HEADER       api.shogo-staging-system.staging.shogo.ai
  ORIGIN_OVERRIDE   https://studio.staging.shogo.ai
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


class HotPathUser(HttpUser):
    # agent turns are long; pace messages so we exercise assignment + proxy
    wait_time = between(3, 8)

    def on_start(self):
        self.cookie = None
        self.project_id = None
        self.workspace_id = None
        self.session_id = f"sess-{random.randint(1,10**9)}"
        self.first_chat = True
        if self._signup():
            self._get_workspace()
            self._create_project()

    # ---- setup helpers (measured) ----
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
            return
        with self.client.post(
            "/api/projects",
            json={"name": f"hotpath-{random.randint(1,10**9)}", "workspaceId": self.workspace_id, "type": "AGENT"},
            headers=self._h(origin=True), catch_response=True, name="/api/projects [CREATE]",
        ) as r:
            if r.status_code in (200, 201):
                try:
                    d = r.json()
                    self.project_id = (
                        d.get("data", {}).get("id") or d.get("id")
                        or d.get("project", {}).get("id") or (d.get("item") or {}).get("id")
                    )
                    r.success()
                except Exception as e:
                    r.failure(f"parse {e}")
            else:
                r.failure(f"{r.status_code}")

    # ---- hot path (measured) ----
    # We stream the SSE response so we can separate:
    #   TTFT (time-to-first-token) = cold-start server cost
    #     (warm-pool assign + pod ready + Object Storage hydration + agent boot
    #      + first LLM token) — this is what the scaling doc is really about.
    #   full turn = TTFT + token generation. The gap between them is inference,
    #     which we do NOT want to blame on infra.
    @task(10)
    def chat(self):
        if not self.project_id:
            return
        cold = self.first_chat
        label = "/projects/:id/chat [cold-start]" if cold else "/projects/:id/chat [warm]"
        ttft_label = "chat_ttft [cold-start]" if cold else "chat_ttft [warm]"
        start = time.time()
        ttft_ms = None
        got_bytes = 0
        try:
            with self.client.post(
                f"/api/projects/{self.project_id}/chat",
                json={
                    "messages": [{"role": "user", "parts": [{"type": "text", "text": random.choice(PROMPTS)}]}],
                    "agentMode": MODEL,
                    "chatSessionId": self.session_id,
                },
                headers=self._h(origin=True), catch_response=True, name=label, timeout=150,
                stream=True,
            ) as r:
                if r.status_code == 200:
                    # Drain the SSE stream, timing the first byte (TTFT).
                    for chunk in r.iter_content(chunk_size=1):
                        if not chunk:
                            continue
                        if ttft_ms is None:
                            ttft_ms = (time.time() - start) * 1000
                        got_bytes += len(chunk)
                    r.success()
                elif r.status_code == 402:
                    r.success()  # usage limit — not an infra fault
                elif r.status_code == 503:
                    r.failure("503 pod_starting (warm-pool miss / not ready)")
                    return
                else:
                    r.failure(f"{r.status_code}")
                    return
        except Exception as e:
            events.request.fire(request_type="POST", name=label, response_time=(time.time() - start) * 1000,
                                response_length=got_bytes, exception=e, context={})
            return

        # Fire the split metrics only for real streamed turns.
        if ttft_ms is not None:
            events.request.fire(request_type="TTFT", name=ttft_label, response_time=ttft_ms,
                                response_length=got_bytes, exception=None, context={})
            if cold:
                events.request.fire(request_type="ASSIGN", name="warm_pool_assign_ttlc",
                                    response_time=ttft_ms, response_length=0, exception=None, context={})
        self.first_chat = False

    @task(3)
    def status(self):
        if not self.project_id:
            return
        with self.client.get(f"/api/projects/{self.project_id}/chat/status",
                             headers=self._h(), catch_response=True,
                             name="/projects/:id/chat/status", timeout=15) as r:
            if r.status_code == 200:
                r.success()
            else:
                r.failure(f"{r.status_code}")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    st = environment.stats
    print("\n==== staging_hotpath summary ====")
    # (label, request_type) — TTFT rows isolate cold-start server cost from the
    # full agent turn; the gap between chat_ttft and chat is token generation.
    rows = [
        ("/api/projects [CREATE]", "POST"),
        ("chat_ttft [cold-start]", "TTFT"),
        ("/projects/:id/chat [cold-start]", "POST"),
        ("chat_ttft [warm]", "TTFT"),
        ("/projects/:id/chat [warm]", "POST"),
        ("warm_pool_assign_ttlc", "ASSIGN"),
    ]
    for name, rtype in rows:
        e = st.get(name, rtype)
        if e and e.num_requests:
            print(f"{name:34s} n={e.num_requests:4d} fail={e.num_failures:3d} "
                  f"med={e.median_response_time:6.0f}ms p95={e.get_response_time_percentile(0.95):6.0f}ms "
                  f"max={e.max_response_time:6.0f}ms")
    t = st.total
    print(f"TOTAL requests={t.num_requests} failures={t.num_failures} "
          f"({(t.num_failures/max(t.num_requests,1))*100:.1f}%) rps={t.total_rps:.1f}")
