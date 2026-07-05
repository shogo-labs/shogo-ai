# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
"""
Phase 5 Locust load test for the metal Firecracker substrate.

Where e2e-load.ts drives the pool in-process on the host, this drives it over
the REAL network via the node-agent HTTP API — the same contract the control
plane (resolveProjectPodUrl `metal` mode) uses — so it measures the wake path a
user actually experiences, including network RTT + HTTP + concurrency contention.

Two user classes (select one on the CLI by name):

  MetalWakeUser      — the microVM sleep/wake cycle against a node-agent:
                       assign (=resume-else-assign) → suspend, repeated. Each
                       virtual user owns a unique project so wakes don't collide.
                       Records the host-reported restore→ready ms as a separate
                       "wake_ready_ms(host)" sample so you can separate host wake
                       cost from network RTT.
                       --host = node-agent base, e.g. http://<host>:9900

  StagingControlPlaneUser — the control-plane registry endpoints on the staging
                       apps/api (bearer-auth). Load-tests host registration +
                       fleet status under churn.
                       --host = staging API base; env METAL_TOKEN required.

Run examples:
  # substrate wake path against the live Ashburn host
  locust -f locustfile.py MetalWakeUser \
    --host http://160.202.128.229:9900 -u 20 -r 5 -t 2m --headless \
    --csv results/metal-wake

  # staging control-plane endpoints
  METAL_TOKEN=... locust -f locustfile.py StagingControlPlaneUser \
    --host https://api.staging.example -u 50 -r 10 -t 1m --headless
"""

import os
import uuid

from gevent.lock import BoundedSemaphore
from locust import HttpUser, between, events, task


PROJECT_PREFIX = os.environ.get("METAL_PROJECT_PREFIX", "loadtest")
METAL_TOKEN = os.environ.get("METAL_TOKEN", "")
# Per-VM env the runtime expects on assign (kept minimal for the pool-mode agent).
ASSIGN_ENV = {"RUNTIME_AUTH_SECRET": "loadtest", "PROJECT_TIER": "starter"}

# Cold boot and snapshot are heavy (a real 2GB runtime cold-boots in ~12s and its
# snapshot writes a ~2GB mem file). Cap how many run at once so warmup/reset don't
# stampede the host — WAKES (restore, the metric) stay fully concurrent. Tune with
# METAL_HEAVY_CONCURRENCY.
_HEAVY = BoundedSemaphore(int(os.environ.get("METAL_HEAVY_CONCURRENCY", "3")))


def _record_host_wake(body):
    """Fire a synthetic sample for the host-reported restore→ready latency so the
    Locust stats separate host wake cost from client↔host network RTT."""
    ready = body.get("readyMs") if isinstance(body, dict) else None
    if ready is None:
        return
    events.request.fire(
        request_type="HOST",
        name="wake_ready_ms(host)",
        response_time=float(ready),
        response_length=0,
        exception=None,
        context={},
    )


class MetalWakeUser(HttpUser):
    """Drives the real suspend→wake cycle of one project through the node-agent."""

    # Think time between reopens of a project.
    wait_time = between(0.5, 2.0)

    def on_start(self):
        self.pid = f"{PROJECT_PREFIX}-{uuid.uuid4().hex[:10]}"
        self.warmed = False
        # Cold open once (assigns a warm microVM), then suspend so the first
        # measured wake is a real restore-from-snapshot, not a cold claim.
        # Serialized behind the heavy-op semaphore so warmup doesn't stampede.
        with _HEAVY:
            with self.client.post(
                "/assign", json={"projectId": self.pid, "env": ASSIGN_ENV},
                name="assign(cold)", catch_response=True,
            ) as r:
                if not r.ok:
                    r.failure(f"cold assign {r.status_code}: {r.text[:180]}")
                    return
            self._suspend()
        self.warmed = True

    def _suspend(self):
        # Caller holds _HEAVY. Snapshot is IO-heavy; keep it capped.
        with self.client.post(
            "/suspend", json={"projectId": self.pid},
            name="suspend", catch_response=True,
        ) as r:
            if not r.ok:
                r.failure(f"suspend {r.status_code}: {r.text[:180]}")

    @task(10)
    def wake(self):
        if not self.warmed:
            return
        # /assign resumes when a snapshot exists — this is the user-facing "wake".
        with self.client.post(
            "/assign", json={"projectId": self.pid, "env": ASSIGN_ENV},
            name="assign(wake)", catch_response=True,
        ) as r:
            if not r.ok:
                r.failure(f"wake {r.status_code}: {r.text[:180]}")
                return
            body = r.json()
            if body.get("mode") != "resumed":
                # Snapshot was lost (evicted / cold miss) — still served, but not a wake.
                r.failure(f"expected resume, got mode={body.get('mode')}")
                return
            _record_host_wake(body)
        # Put it back to sleep for the next cycle (frees host RAM). Snapshot is
        # heavy → serialize behind the semaphore; the wake above stayed concurrent.
        with _HEAVY:
            self._suspend()

    @task(1)
    def status(self):
        self.client.get("/vms", name="vms")

    def on_stop(self):
        # Best-effort: leave the project suspended (RAM freed), not assigned.
        try:
            with _HEAVY:
                self.client.post("/suspend", json={"projectId": self.pid}, name="suspend")
        except Exception:
            pass


class StagingControlPlaneUser(HttpUser):
    """Load-tests the staging apps/api metal registry endpoints (bearer auth)."""

    wait_time = between(0.25, 1.0)

    def _auth(self):
        return {"Authorization": f"Bearer {METAL_TOKEN}"} if METAL_TOKEN else {}

    def on_start(self):
        self.host_id = f"loadtest-host-{uuid.uuid4().hex[:8]}"

    @task(3)
    def register(self):
        payload = {
            "hostId": self.host_id,
            "meshIp": "10.255.0.99",
            "agentPort": 9900,
            "region": "loadtest",
            "arch": "x64",
            "capacity": {"poolSize": 4, "memMiB": 2048, "vcpus": 2},
            "load": {"available": 1, "assigned": 0, "suspended": 0, "ts": int(time.time())},
        }
        with self.client.post(
            "/api/internal/metal/register", json=payload, headers=self._auth(),
            name="metal/register", catch_response=True,
        ) as r:
            if r.status_code == 401:
                r.failure("unauthorized — set METAL_TOKEN")
            elif not r.ok:
                r.failure(f"register {r.status_code}: {r.text[:180]}")

    @task(1)
    def status(self):
        with self.client.get(
            "/api/internal/metal/status", headers=self._auth(),
            name="metal/status", catch_response=True,
        ) as r:
            if r.status_code == 401:
                r.failure("unauthorized — set METAL_TOKEN")
            elif not r.ok:
                r.failure(f"status {r.status_code}: {r.text[:180]}")
