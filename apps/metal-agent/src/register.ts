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

import { readFileSync } from 'fs'
import { config } from './config'
import { rootDiskUsage } from './disk'
import { currentIdleWindow, setIdleDirective, type IdleDirective } from './idle-policy'
import { metrics, M } from './metrics'
import type { MetalWarmPool } from './pool'
import {
  getRootfsRevision,
  getRootfsSha,
  getStagedRootfs,
  maybeActivateRootfs,
  maybeRebuildRootfs,
  maybeSelfUpdate,
  type DesiredAgent,
  type RootfsHooks,
} from './self-update'

/** The staged rootfs as the control plane sees it (drives pre-warm and activation). */
function stagedRootfsReport(pool: MetalWarmPool) {
  const staged = getStagedRootfs()
  if (!staged) return undefined
  return {
    version: staged.version,
    identities: staged.identities,
    stagedAt: staged.stagedAt,
    // False when this host can't boot on the staged image (pinned identity):
    // the control plane then activates it without a pre-warm.
    prewarm: pool.stagedRootfs('standard')?.identity === staged.identities.standard,
    stagedSnapshots: pool.capacity().stagedCount,
  }
}

/** MemTotal / MemAvailable from /proc/meminfo, in MiB. Undefined off Linux. */
export function hostMemory(meminfo?: string): { totalMiB: number; availableMiB: number } | undefined {
  let text = meminfo
  if (text === undefined) {
    try {
      text = readFileSync('/proc/meminfo', 'utf8')
    } catch {
      return undefined
    }
  }
  const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text!)?.[1])
  const total = kb('MemTotal')
  const available = kb('MemAvailable')
  if (!(total > 0) || !(available >= 0)) return undefined
  return { totalMiB: Math.round(total / 1024), availableMiB: Math.round(available / 1024) }
}

function payload(pool: MetalWarmPool, opts: { restarting?: boolean } = {}) {
  const s = pool.status()
  const cap = pool.capacity()
  const rootDisk = rootDiskUsage('/')
  metrics.gauge(M.rootDiskUsedPct, rootDisk.usedPct)
  metrics.gauge(M.rootDiskFreeBytes, rootDisk.freeBytes)
  return {
    hostId: config.hostId,
    meshIp: config.meshIp,
    agentPort: config.listenPort,
    region: config.region,
    arch: process.arch, // 'x64' | 'arm64' — control plane matches to image arch
    // Running version, so the control plane sees fleet skew and resolves the
    // desired version to send back for a pull-based self-update.
    agentVersion: config.agentVersion,
    // The OTHER version dimension: which release's runtime image the guest
    // rootfs was last rebuilt from. Agent code and guest rootfs update on
    // independent triggers (see self-update.ts), so a host can be current on
    // one and stale on the other — reporting both is what makes that skew
    // visible without SSHing in to cat ROOTFS_SHA.
    rootfsSha: getRootfsSha() ?? undefined,
    // The commit stamped inside the image itself. rootfsSha records which
    // release asked for the rebuild, not what the pull returned; the release
    // gate (scripts/ci/metal-rootfs-gate.sh) reads this one.
    rootfsRevision: getRootfsRevision() ?? undefined,
    stagedRootfs: stagedRootfsReport(pool),
    // Sent once, by the shutting-down process: the control port is about to
    // drop for a few seconds, so callers retry instead of failing an open.
    ...(opts.restarting ? { restarting: true } : {}),
    capacity: { poolSize: config.poolSize, memMiB: config.memMiB, vcpus: config.vcpus },
    // Per-VM-class capacity (Phase 1 docker project class). `classes` is the
    // ONLY place a host declares it can run a non-standard class — the control
    // plane's candidate filtering must never route a class to a host that
    // doesn't advertise `supported:true` here, however an assign env is
    // shaped (see metal-warm-pool-controller.ts). `capacity` above is kept
    // exactly as before for any consumer that hasn't been updated to read
    // per-class data yet — it always mirrors the 'standard' entry.
    classes: s.classes,
    load: {
      available: s.available,
      assigned: s.assigned.length,
      suspended: s.suspended.length,
      // Live firecracker processes. Should equal available+assigned; a growing
      // gap is the churn process-leak fingerprint (the control plane turns this
      // into a fleet-wide alarm so a recurrence is caught without SSH).
      fcProcs: s.fcProcs,
      // Why the assigned VMs are live: end-user app traffic vs in-flight agent
      // turns vs the idle-suspend tail. Lets the control plane report "N running
      // = X app-users + Y agent-turns + Z idle" instead of one opaque number.
      liveness: s.liveness,
      // How much of this host's finite /30 space (16384 blocks, one per tap) is
      // occupied. Reported because tap exhaustion is invisible from anywhere
      // else: nothing degrades until the last block is gone, and then every
      // /assign here fails. The GC reclaims leaked devices, so a number far
      // above available+assigned+suspended means the leak is outrunning it.
      taps: pool.tapUsage(),
      // Host RAM, so warm-up work is gated on real headroom rather than on a
      // VM count (idle VMs are small; a count cap held a staging pre-warm back
      // for its whole window).
      mem: hostMemory(),
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
    // The ROOT filesystem — where docker images for the runtime rootfs live. The
    // NVMe fields above never described it, so a host whose root disk filled
    // with stale images looked healthy while it failed every update (dal-2,
    // 2026-10-31). Old agents simply omit this.
    rootDisk: rootDisk,
    metrics: metrics.snapshot().counters,
    // Only meaningful when the reaper runs; the control plane's hysteresis reads `directiveTier`.
    idle: config.idleSuspendMs > 0 ? currentIdleWindow(s.assigned.length) : undefined,
    ts: Date.now(),
  }
}

interface RegisterResponse {
  ok?: boolean
  /** Version this host should be running (pull-based deploy). */
  desired?: DesiredAgent | null
  /** Idle-suspend window for this host (see idle-policy.ts). */
  idleSuspend?: IdleDirective | null
  /** Staged rootfs version the control plane says to switch to now (see self-update.ts). */
  activateRootfs?: string | null
}

async function announce(
  pool: MetalWarmPool,
  opts: { restarting?: boolean; timeoutMs?: number } = {},
): Promise<RegisterResponse | null> {
  const url = `${config.controlPlaneUrl.replace(/\/$/, '')}/api/internal/metal/register`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.registerToken ? { Authorization: `Bearer ${config.registerToken}` } : {}),
      },
      body: JSON.stringify(payload(pool, opts)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    })
    if (!res.ok) {
      console.warn(`[metal-agent] register ${res.status}: ${await res.text().catch(() => '')}`)
      return null
    }
    return (await res.json().catch(() => ({}))) as RegisterResponse
  } catch (err: any) {
    console.warn(`[metal-agent] register failed: ${err?.message ?? err}`)
    return null
  }
}

/**
 * Report a placement event to the control plane so the shared registry reflects
 * host-side suspend/evict promptly (instead of waiting for the next heartbeat).
 * Best-effort and fire-and-forget: a failure just means the registry converges
 * a little later. No-op when no control plane is configured.
 */
export function reportPlacement(
  event: 'suspended' | 'evicted' | 'cold',
  projectId: string,
  opts: { refresh?: 'stale-rootfs' | 'stale-rootfs-always-on' } = {},
): void {
  if (!config.controlPlaneUrl) return
  const url = `${config.controlPlaneUrl.replace(/\/$/, '')}/api/internal/metal/placement`
  void fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.registerToken ? { Authorization: `Bearer ${config.registerToken}` } : {}),
    },
    // `refresh`: the VM was retired off a superseded rootfs, so the control
    // plane should re-warm it on the current one (and leave an always-on one
    // running).
    body: JSON.stringify({ hostId: config.hostId, projectId, event, ...(opts.refresh ? { refresh: opts.refresh } : {}) }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {})
}

/**
 * Final heartbeat from a process about to exit for a restart, so the control
 * plane rides out the few seconds the control port is down. Bounded: a slow
 * control plane must not hold up the shutdown.
 */
export async function announceRestarting(pool: MetalWarmPool): Promise<void> {
  if (!config.controlPlaneUrl) return
  await announce(pool, { restarting: true, timeoutMs: 1500 })
}

export function rootfsHooks(pool: MetalWarmPool): RootfsHooks {
  const list = (ids: { standard: string; docker?: string }) => [ids.standard, ...(ids.docker ? [ids.docker] : [])]
  return {
    onStaged: (ids) => void pool.dropStagedSnapshots(list(ids)),
    promote: (ids) => pool.promoteStagedSnapshots(list(ids)),
  }
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
  const hooks = rootfsHooks(pool)
  const tick = async () => {
    if (stopped) return
    const res = await announce(pool)
    if (res) console.log(`[metal-agent] registered (heartbeat every ${config.registerIntervalMs}ms)`)
    if (res?.idleSuspend) setIdleDirective(res.idleSuspend)
    // A staged rootfs switches on the control plane's word, or on our own once
    // it has waited too long. Checked even when the heartbeat failed, so a host
    // cut off from the control plane still converges.
    if (await maybeActivateRootfs(res?.activateRootfs, hooks)) return
    // Pull-based deploy: converge to the version the control plane wants. Applies
    // only on a real change; a graceful restart follows (live microVMs survive).
    if (res?.desired) {
      const updated = await maybeSelfUpdate(res.desired)
      // No code-version change, but the release may still ask for a rootfs rebuild
      // (a same-version rebuild-flagged release — the runtime-image workflow_run
      // path). Decoupled from the version gate so that signal isn't dropped.
      if (!updated) await maybeRebuildRootfs(res.desired, hooks)
    }
  }
  void tick()
  const timer = setInterval(tick, config.registerIntervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
