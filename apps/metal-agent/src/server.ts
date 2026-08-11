// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Node-agent HTTP API. Runs on each bare-metal host and fronts the local
 * MetalWarmPool so the shogo control plane (apps/api, over the mesh) can:
 *
 *   GET  /healthz                      liveness
 *   GET  /vms                          pool status
 *   POST /assign      {projectId,env}  claim+assign OR resume-if-suspended;
 *                                      returns the in-guest agent URL
 *   POST /suspend     {projectId}      snapshot-on-idle (free host RAM)
 *   POST /resume      {projectId}      restore-from-snapshot (the "wake")
 *   POST /touch       {projectId}      keep-alive (defers idle auto-suspend)
 *
 * Suspend-on-idle runs automatically via a reaper loop (METAL_IDLE_SUSPEND_MS);
 * snapshots optionally persist to a durable store for cross-host mobility.
 *
 * This is the server behind the `metal` pod-mode added to resolveProjectPodUrl
 * in Phase 4. Every route above except /healthz requires the control-plane
 * bearer, gated by METAL_AUTH_MODE — see auth.ts for the decision table and why
 * it ships defaulting to observe rather than enforcing on arrival.
 */

import { type AuthMode, bucketPath, decideControlAuth, parseAuthMode } from './auth'
import { config } from './config'
import { ControlFirewall } from './control-firewall'
import { type GuardedInterval, guardedInterval } from './guarded-interval'
import { HYDRATE_STREAM_PREFIX } from './hydrate-proxy'
import { M, metrics } from './metrics'
import { MetalWarmPool } from './pool'
import { PortForward } from './port-forward'
import { reportPlacement, startRegistration } from './register'
import { SerialWatcher } from './serial-watcher'
const pool = new MetalWarmPool()
// Pre-mesh data path: DNAT a public host port to each assigned guest and hand
// back http://{publicHost}:{port}. No-op (returns the private guest URL) unless
// METAL_PUBLIC_HOST is set.
const fwd = new PortForward()
if (fwd.enabled) console.log(`[metal-agent] public port-forward on: ${config.publicHost}:${config.fwdPortBase}-${config.fwdPortBase + config.fwdPortSpan - 1} allow=${config.fwdAllowCidr || 'any'}`)

// Packet filter on our own control port, under the METAL_AUTH_MODE bearer.
// Applied before the pool starts so there is no window where the port is open
// wider than intended, and never fatal: a host that cannot run iptables should
// still serve its projects rather than fail to boot.
const ctrlFirewall = new ControlFirewall()
try {
  ctrlFirewall.apply()
  console.log(`[metal-agent] control firewall: ${ctrlFirewall.describe()}`)
} catch (err: any) {
  console.error(`[metal-agent] control firewall FAILED to apply (port stays open): ${err?.message ?? err}`)
}

async function json(req: Request): Promise<any> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

const authMode: AuthMode = parseAuthMode(process.env.METAL_AUTH_MODE)

/**
 * Throttle for the uncredentialed-request log line, keyed by path+reason.
 *
 * :9900 faces the internet, so this line is reachable by anyone with a port
 * scanner. Unthrottled it is a way to fill the host's disk through journald,
 * and it would bury the message that matters — the control plane call that is
 * still missing its token during a rollout. The counter is exact; the log only
 * needs to be legible.
 */
const AUTH_LOG_INTERVAL_MS = 60_000
const authLoggedAt = new Map<string, number>()
function logUnauthenticated(pathLabel: string, reason: string, peerIp: string | null): void {
  const key = `${pathLabel}|${reason}`
  const now = Date.now()
  const last = authLoggedAt.get(key) ?? 0
  if (now - last < AUTH_LOG_INTERVAL_MS) return
  authLoggedAt.set(key, now)
  const verb = authMode === 'enforce' ? 'refused' : 'allowed (observe)'
  console.warn(`[metal-agent] control auth ${verb}: path=${pathLabel} reason=${reason} peer=${peerIp ?? 'unknown'}`)
}

const server = Bun.serve({
  hostname: config.listenHost,
  port: config.listenPort,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const path = url.pathname
    try {
      const peerIp = srv.requestIP(req)?.address ?? null
      const auth = decideControlAuth({
        mode: authMode,
        path,
        authorization: req.headers.get('authorization'),
        expectedToken: config.registerToken,
        peerIp,
      })
      if (auth.suspicious) {
        const pathLabel = bucketPath(path)
        metrics.inc(`${M.controlUnauthenticated}{path="${pathLabel}",reason="${auth.reason}"}`)
        logUnauthenticated(pathLabel, auth.reason, peerIp)
      }
      if (!auth.allow) return Response.json({ error: 'unauthorized' }, { status: 401 })

      if (path === '/healthz') return Response.json({ ok: true })
      if (path === '/vms') return Response.json(pool.status())
      if (path === '/metrics') return new Response(metrics.prometheus(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } })

      // A guest redeeming a hydrate grant. Not part of the control-plane API:
      // the caller is a local guest over its tap, and the bearer token this
      // API is otherwise protected by lives inside the guest we are about to
      // populate. The unguessable single-use token in the path, pinned to the
      // guest it was minted for, is the credential — see `hydrate-proxy`.
      if (path.startsWith(HYDRATE_STREAM_PREFIX) && req.method === 'GET') {
        return pool.hydrateProxy.serve(path, srv.requestIP(req)?.address ?? null)
      }

      if (path === '/assign' && req.method === 'POST') {
        const { projectId, env } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        // Resume-or-assign under one singleflight key (no double cold-boot on a
        // concurrent burst). A stale/cold miss falls through to a fresh assign.
        const r = await pool.open(projectId, env ?? {})
        const url = await fwd.ensure(projectId, r.handle.guestIp)
        return Response.json({ url, mode: r.mode, source: r.source, readyMs: r.readyMs, reused: r.reused })
      }

      if (path === '/gc' && req.method === 'POST') {
        const { force } = await json(req)
        const report = await pool.gcSweep({ force: !!force })
        // Tell the control plane which projects lost their local copy so cache-
        // aware routing stops preferring this host for them.
        for (const id of report.evicted) reportPlacement(report.durableRemoved.includes(id) ? 'cold' : 'evicted', id)
        return Response.json(report)
      }

      if (path === '/suspend' && req.method === 'POST') {
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const s = await pool.suspend(projectId)
        fwd.remove(projectId)
        reportPlacement('suspended', projectId) // still cached locally here
        return Response.json({ ok: true, memBytes: s.snapshot.bytesMem })
      }

      if (path === '/resume' && req.method === 'POST') {
        const { projectId, env } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const r = await pool.resume(projectId, env ?? {})
        if (!r) return Response.json({ error: 'no restorable snapshot (cold miss)' }, { status: 409 })
        const url = await fwd.ensure(projectId, r.assigned.handle.guestIp)
        return Response.json({ url, source: r.source, readyMs: r.readyMs })
      }

      if (path === '/touch' && req.method === 'POST') {
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        pool.touch(projectId)
        return Response.json({ ok: true })
      }

      if (path === '/status' && req.method === 'POST') {
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        return Response.json(pool.getProjectStatus(projectId))
      }

      if (path === '/stop' && req.method === 'POST') {
        // "stop" == suspend-to-snapshot: free host RAM but keep the project
        // resumable (parity with Knative scale-to-zero). Idempotent — a project
        // that isn't currently assigned is already stopped.
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        if (!pool.getAssigned(projectId)) return Response.json({ ok: true, alreadyStopped: true, suspended: false })
        // Never suspend a project mid-generation: snapshotting it would kill the
        // active agent message. Report busy so the control plane leaves it in the
        // user's open set and retries the eviction on a later (idle) open.
        if (await pool.isBusy(projectId)) return Response.json({ ok: true, busy: true, suspended: false })
        const s = await pool.suspend(projectId)
        fwd.remove(projectId)
        reportPlacement('suspended', projectId)
        return Response.json({ ok: true, suspended: true, memBytes: s.snapshot.bytesMem })
      }

      if (path === '/destroy' && req.method === 'POST') {
        // Permanent teardown on project delete: stop VM + drop local snapshot +
        // durable copy so nothing leaks. Tell the control plane the project is
        // gone from this host so cache-aware routing stops preferring it.
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const r = await pool.destroy(projectId)
        fwd.remove(projectId)
        reportPlacement('cold', projectId)
        return Response.json({ ok: true, ...r })
      }

      if (path === '/resize' && req.method === 'POST') {
        // Instance-tier change. Firecracker can't hot-resize vCPU/RAM, so the
        // size takes effect on the next cold boot/resume (the assign env is
        // re-read then); what we apply LIVE is the always-on flag so a paid
        // upgrade immediately stops the idle reaper (and a downgrade re-arms it).
        const { projectId, alwaysOn } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const applied = pool.applyResize(projectId, { alwaysOn })
        return Response.json({ ok: true, applied })
      }

      return new Response('not found', { status: 404 })
    } catch (err: any) {
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 })
    }
  },
})

console.log(`[metal-agent] listening on http://${config.listenHost}:${server.port}`)
console.log(
  `[metal-agent] control auth: ${authMode}` +
    (config.registerToken ? '' : ' (NO TOKEN CONFIGURED — enforce would refuse every non-loopback caller)'),
)
console.log('[metal-agent] warming pool...')
pool.start().then(
  (adoption) => {
    console.log('[metal-agent] pool ready')
    // Rolling deploy: adopt() re-attached live VMs that survived this restart.
    // Re-assert their (persisted) DNAT rules and tear down forwards for any VM
    // that was NOT re-adopted, so the public data path matches reality.
    try {
      const kept = fwd.retainAndReassert(new Set(adoption.adopted))
      if (adoption.adopted.length || adoption.reaped) {
        console.log(
          `[metal-agent] adopted ${adoption.adopted.length} live VM(s); ${kept} forward(s) retained; reaped ${adoption.reaped} non-adopted FC proc(s)`,
        )
      }
    } catch (err: any) {
      console.error('[metal-agent] forward reassert failed:', err?.message ?? err)
    }
    // Reclaim files left over from a prior run once the suspended index is
    // rehydrated (start() calls rehydrate()), so a deploy doesn't leak disk.
    try {
      const n = pool.reclaimOrphans()
      if (n) console.log(`[metal-agent] startup reclaimed ${n} orphaned artifact(s)`)
    } catch (err: any) {
      console.error('[metal-agent] startup orphan reclaim failed:', err?.message ?? err)
    }
  },
  (err) => console.error('[metal-agent] pool warmup failed:', err?.message ?? err),
)

// Announce this host to the control plane over the mesh (no-op if unconfigured).
// The heartbeat response carries the desired agent version (register.ts calls
// maybeSelfUpdate on it) — this is the SINGLE source of truth for self-update.
//
// A second carrier (polling an S3/https manifest directly) used to run alongside
// this, but the two disagreed whenever CI updated the DB channel pointer without
// also rewriting the manifest: each poller "corrected" the other and the agent
// restart-looped every ~20s (dropping in-flight resumes). Removed — the DB-backed
// desired-version resolver (apps/api metal-agent-release.ts) is the only pointer.
const stopRegistration = startRegistration(pool)
console.log(`[metal-agent] self-update: ${config.selfUpdate ? 'on (heartbeat desired)' : 'off'} version=${config.agentVersion}`)

// Guest serial-log error watcher: tails each live VM's serial console and
// re-emits known in-guest failures (TLS cert-not-yet-valid from resume clock
// skew, provider/connection errors, inference retries) as host-side ERROR/WARN
// logs (-> journald -> otelcol-metal -> SigNoz) + counters. This is the only
// central signal for guests too broken to ship their own telemetry — the exact
// blind spot behind the "provider connection error" incidents. See
// apps/metal-agent/src/serial-watcher.ts.
let serialWatcher: SerialWatcher | null = null
if (config.serialWatch) {
  serialWatcher = new SerialWatcher()
  serialWatcher.start()
  console.log(`[metal-agent] guest serial-log watcher on: interval=${config.serialWatchIntervalMs}ms`)
}

// Idle reaper: fold real guest traffic into idleness (activity poll), then
// quiesce + snapshot assigned VMs that have gone quiet (free host RAM).
let reaper: GuardedInterval | null = null
if (config.idleSuspendMs > 0) {
  console.log(`[metal-agent] idle-suspend on: idleMs=${config.idleSuspendMs} scan=${config.reapIntervalMs}ms store=${config.snapStore}`)
  // Guarded: a pass is sequential and each suspend backs up source + writable
  // state to S3, quiesces, then snapshots, so on a host holding ~130 VMs one pass
  // runs far longer than the 15s scan. See `guardedInterval` for what overlapping
  // passes did to production.
  reaper = guardedInterval('idle reaper', config.reapIntervalMs, () =>
    // Liveness sweep FIRST: clear any assigned VM whose firecracker process has
    // died. A continuously wake-polled dead VM never goes idle (each poll bumps
    // lastTouchedAt), so the idle reaper below can't help — this is the only
    // thing that stops routing from resolving to a dead box (the "Unable to
    // connect" 502 loop). Drop its DNAT forward and tell the control plane the
    // project is gone from here so it re-places / cold-boots on the next open.
    pool
      .reapDeadAssigned()
      .then((deadIds) => {
        for (const id of deadIds) {
          fwd.remove(id)
          reportPlacement('cold', id)
        }
        if (deadIds.length) console.log(`[metal-agent] reaped dead assigned VM(s): ${deadIds.join(', ')}`)
      })
      .catch((err) => console.error('[metal-agent] dead-vm reap error:', err?.message ?? err))
      .then(() => pool.pollActivity().catch(() => {}))
      .then(() => pool.reapIdle())
      .then((ids) => {
        for (const id of ids) {
          fwd.remove(id)
          reportPlacement('suspended', id)
        }
        if (ids.length) console.log(`[metal-agent] idle-suspended: ${ids.join(', ')}`)
      }),
  )
}

// GC sweep: reclaim orphans + evict LRU suspended snapshots under disk pressure
// (treats NVMe as a bounded cache backed by the durable store).
let gc: ReturnType<typeof setInterval> | null = null
if (config.gcIntervalMs > 0) {
  console.log(
    `[metal-agent] gc on: interval=${config.gcIntervalMs}ms high=${config.diskHighPct}% low=${config.diskLowPct}% ` +
      `cacheMax=${config.cacheMaxBytes || 'off'} rootfsCow=${config.rootfsCow}`,
  )
  gc = setInterval(() => {
    // Safety net: SIGKILL any firecracker process orphaned by a failure/race
    // path (the churn leak). Normally 0 — every failure path now stops its own
    // VM — but this guarantees the host can't accumulate untracked FC processes.
    try {
      pool.reapOrphanProcs()
    } catch (err: any) {
      console.error('[metal-agent] orphan-proc reap error:', err?.message ?? err)
    }
    // Reclaim leaked dm devices / loops / CoW files from teardown races (bounded
    // per sweep so a large backlog drains gradually without stalling the timer).
    try {
      const n = pool.reconcileOrphanDevices()
      if (n) console.log(`[metal-agent] reconciled ${n} orphaned dm device(s)/CoW`)
    } catch (err: any) {
      console.error('[metal-agent] orphan-device reconcile error:', err?.message ?? err)
    }
    pool.gcSweep().then(
      (report) => {
        for (const id of report.evicted) reportPlacement(report.durableRemoved.includes(id) ? 'cold' : 'evicted', id)
      },
      (err) => console.error('[metal-agent] gc error:', err?.message ?? err),
    )
  }, config.gcIntervalMs)
}

// Published-data exporter: periodically flush every live SERVER-BACKED published
// microVM's writable state (SQLite DB + uploads) to the published-data bucket.
// Always-on sites may run for weeks without a suspend, so relying on the
// suspend-time export alone would risk losing end-user writes on a host loss.
// Host-side (the guest holds no S3 creds); best-effort.
let pubDataExporter: ReturnType<typeof setInterval> | null = null
if (config.publishDataBucket && config.publishDataExportIntervalMs > 0) {
  console.log(
    `[metal-agent] published-data export on: interval=${config.publishDataExportIntervalMs}ms bucket=${config.publishDataBucket}`,
  )
  pubDataExporter = setInterval(() => {
    pool.exportAllPublishedData().then(
      (n) => {
        if (n) console.log(`[metal-agent] exported published-data for ${n} live site(s)`)
      },
      (err) => console.error('[metal-agent] published-data exporter error:', err?.message ?? err),
    )
  }, config.publishDataExportIntervalMs)
}

// Writable-state exporter: periodically persist EVERY live microVM's database
// and uploads to `{projectId}/project-data.tar.gz`. This is the durability that
// makes a snapshot loss survivable — a golden-rootfs rebuild invalidates every
// snapshot at once, and the cold boot that follows restores source only, so
// without this the user's runtime data is destroyed. Host-side; best-effort;
// unchanged databases are skipped by content hash.
let projectDataExporter: GuardedInterval | null = null
if (config.projectDataExportIntervalMs > 0) {
  console.log(
    `[metal-agent] writable-state export on: interval=${config.projectDataExportIntervalMs}ms`,
  )
  // Guarded: a sweep across every live VM can outlast the interval on a busy
  // host (each project may snapshot a database and upload it).
  projectDataExporter = guardedInterval(
    'writable-state export',
    config.projectDataExportIntervalMs,
    () =>
      pool.exportAllProjectData().then((n) => {
        if (n) console.log(`[metal-agent] exported writable state for ${n} project(s)`)
      }),
  )
}

// Graceful shutdown for rolling deploys. systemd is configured `KillMode=process`
// so it signals ONLY this agent; the firecracker children keep running. We must
// therefore NOT tear down the live data path: leave assigned VMs and their DNAT
// rules in place (the next instance re-adopts them via pool.adopt()), and only
// release warm/idle pool VMs. A kill of the assigned VMs here would defeat the
// whole point — the user would see a cold resume on every deploy.
process.on('SIGTERM', async () => {
  console.log('[metal-agent] SIGTERM: graceful restart — keeping assigned microVMs + forwards alive')
  stopRegistration()
  serialWatcher?.stop()
  reaper?.stop()
  if (gc) clearInterval(gc)
  if (pubDataExporter) clearInterval(pubDataExporter)
  projectDataExporter?.stop()
  await pool.prepareForRestart().catch(() => {})
  process.exit(0)
})
