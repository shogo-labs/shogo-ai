// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Mesh registration — the node-agent side of the `metal` pod-mode control-plane
 * contract (Phase 4). On startup and on a heartbeat interval, the node-agent
 * announces its mesh address + capacity to apps/api so resolveProjectPodUrl can
 * pick a host and POST /assign to it over the WireGuard mesh.
 *
 * Contract (apps/api — implemented in Phase 4, routes/metal.ts):
 *   POST ${controlPlaneUrl}/api/internal/metal/register
 *   Authorization: Bearer ${registerToken}
 *   { hostId, meshIp, agentPort, region, arch, capacity:{poolSize,memMiB,vcpus} }
 *
 * Best-effort and non-fatal: registration failures never take the agent down
 * (it still serves the local pool), they just mean the control plane won't
 * route new projects here until the next successful heartbeat.
 */

import { config } from './config'
import { metrics } from './metrics'
import type { MetalWarmPool } from './pool'

function payload(pool: MetalWarmPool) {
  const s = pool.status()
  const cap = pool.capacity()
  return {
    hostId: config.hostId,
    meshIp: config.meshIp,
    agentPort: config.listenPort,
    region: config.region,
    arch: process.arch, // 'x64' | 'arm64' — control plane matches to image arch
    capacity: { poolSize: config.poolSize, memMiB: config.memMiB, vcpus: config.vcpus },
    load: {
      available: s.available,
      assigned: s.assigned.length,
      suspended: s.suspended.length,
      // Live firecracker processes. Should equal available+assigned; a growing
      // gap is the churn process-leak fingerprint (the control plane turns this
      // into a fleet-wide alarm so a recurrence is caught without SSH).
      fcProcs: s.fcProcs,
    },
    // NVMe cache scalars so the control plane can route disk- and cache-aware
    // (Phase 2) without shipping per-project cache manifests in the heartbeat.
    disk: {
      totalBytes: cap.totalBytes,
      freeBytes: cap.freeBytes,
      usedPct: cap.usedPct,
      cacheBytes: cap.cacheBytes,
      localCount: cap.localCount,
    },
    metrics: metrics.snapshot().counters,
    ts: Date.now(),
  }
}

async function announce(pool: MetalWarmPool): Promise<boolean> {
  const url = `${config.controlPlaneUrl.replace(/\/$/, '')}/api/internal/metal/register`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.registerToken ? { Authorization: `Bearer ${config.registerToken}` } : {}),
      },
      body: JSON.stringify(payload(pool)),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.warn(`[metal-agent] register ${res.status}: ${await res.text().catch(() => '')}`)
      return false
    }
    return true
  } catch (err: any) {
    console.warn(`[metal-agent] register failed: ${err?.message ?? err}`)
    return false
  }
}

/**
 * Report a placement event to the control plane so the shared registry reflects
 * host-side suspend/evict promptly (instead of waiting for the next heartbeat).
 * Best-effort and fire-and-forget: a failure just means the registry converges
 * a little later. No-op when no control plane is configured.
 */
export function reportPlacement(event: 'suspended' | 'evicted' | 'cold', projectId: string): void {
  if (!config.controlPlaneUrl) return
  const url = `${config.controlPlaneUrl.replace(/\/$/, '')}/api/internal/metal/placement`
  void fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.registerToken ? { Authorization: `Bearer ${config.registerToken}` } : {}),
    },
    body: JSON.stringify({ hostId: config.hostId, projectId, event }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {})
}

/**
 * Start the registration heartbeat. Returns a stop() to clear the timer.
 * No-op (with a log) when no control plane is configured.
 */
export function startRegistration(pool: MetalWarmPool): () => void {
  if (!config.controlPlaneUrl) {
    console.log('[metal-agent] METAL_CONTROL_PLANE_URL unset — running standalone (no mesh registration)')
    return () => {}
  }
  console.log(
    `[metal-agent] registering with control plane ${config.controlPlaneUrl} as host=${config.hostId} meshIp=${config.meshIp} arch=${process.arch}`,
  )
  let stopped = false
  const tick = async () => {
    if (stopped) return
    const ok = await announce(pool)
    if (ok) console.log(`[metal-agent] registered (heartbeat every ${config.registerIntervalMs}ms)`)
  }
  void tick()
  const timer = setInterval(tick, config.registerIntervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
