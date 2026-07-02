"""
Staging connection-pool tuning load test.

Exercises the Better Auth pg pool (AUTH_POOL_SIZE) and the Prisma pool via a
realistic authed read/write mix. Targets the Kourier LB over plain HTTP, so the
`__Secure-` session cookies are captured from sign-up and replayed manually as a
Cookie header (browsers/requests won't send Secure cookies over http://).

Env:
  API_BASE_URL      e.g. http://141.148.27.1  (kourier LB, HTTP)
  HOST_HEADER       api.shogo-staging-system.staging.shogo.ai
  ORIGIN_OVERRIDE   https://studio.staging.shogo.ai  (trusted CSRF origin)
  LOAD_TEST_SECRET  rate-limit bypass key
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

COOKIE_RE = re.compile(r"(__Secure-shogo\.[A-Za-z_]+=[^;]+)")


def base_headers():
    h = {}
    if SECRET:
        h["X-Load-Test-Key"] = SECRET
    if HOST_HEADER:
        h["Host"] = HOST_HEADER
    return h


class StagingMixUser(HttpUser):
    wait_time = between(1, 3)

    def on_start(self):
        self.cookie = None
        self.authed = False
        self._signup()

    def _signup(self):
        uid = random.randint(config.USER_ID_MIN, config.USER_ID_MAX)
        stamp = int(time.time() * 1000) % 1_000_000
        email = f"{config.TEST_USER_PREFIX}-{uid}-{stamp}@test.shogo.ai"
        hdrs = {**base_headers(), "Origin": ORIGIN}
        with self.client.post(
            "/api/auth/sign-up/email",
            json={"email": email, "password": config.TEST_USER_PASSWORD, "name": f"LT {uid}"},
            headers=hdrs,
            catch_response=True,
            name="/api/auth/sign-up/email",
        ) as r:
            if r.status_code == 200:
                raw = r.headers.get("set-cookie") or r.headers.get("Set-Cookie") or ""
                pairs = COOKIE_RE.findall(raw)
                if pairs:
                    self.cookie = "; ".join(pairs)
                    self.authed = True
                r.success()
            elif r.status_code in (409, 422, 429):
                # already exists / throttled — not a server fault for this test
                r.success()
            else:
                r.failure(f"signup {r.status_code}")

    def _authed_headers(self):
        h = base_headers()
        if self.cookie:
            h["Cookie"] = self.cookie
        return h

    def _get(self, path):
        with self.client.get(
            path, headers=self._authed_headers(), catch_response=True, name=path
        ) as r:
            if r.status_code == 200:
                r.success()
            else:
                r.failure(f"{r.status_code}")

    @task(10)
    def get_session(self):
        self._get("/api/auth/get-session")

    @task(8)
    def templates(self):
        self._get("/api/templates")

    @task(6)
    def workspaces(self):
        self._get("/api/workspaces")

    @task(6)
    def projects(self):
        self._get("/api/projects")

    @task(3)
    def folders(self):
        self._get("/api/folders")

    @task(3)
    def members(self):
        self._get("/api/members")

    @task(2)
    def health(self):
        self._get("/api/health")

    @task(2)
    def reauth(self):
        # fresh signup exercises the auth write path + Better Auth pool
        self._signup()


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    s = environment.stats.total
    print("\n==== staging_mix summary ====")
    print(f"requests      : {s.num_requests}")
    print(f"failures      : {s.num_failures} ({(s.num_failures/max(s.num_requests,1))*100:.2f}%)")
    print(f"median (ms)   : {s.median_response_time}")
    print(f"p95 (ms)      : {s.get_response_time_percentile(0.95)}")
    print(f"p99 (ms)      : {s.get_response_time_percentile(0.99)}")
    print(f"rps           : {s.total_rps:.1f}")
