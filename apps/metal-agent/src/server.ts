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
 * in Phase 4. Auth (bearer over the WireGuard mesh) is added there.
 */

import { config } from './config'
import { metrics } from './metrics'
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

async function json(req: Request): Promise<any> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

const server = Bun.serve({
  hostname: config.listenHost,
  port: config.listenPort,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    try {
      if (path === '/healthz') return Response.json({ ok: true })
      if (path === '/vms') return Response.json(pool.status())
      if (path === '/metrics') return new Response(metrics.prometheus(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } })

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
let reaper: ReturnType<typeof setInterval> | null = null
if (config.idleSuspendMs > 0) {
  console.log(`[metal-agent] idle-suspend on: idleMs=${config.idleSuspendMs} scan=${config.reapIntervalMs}ms store=${config.snapStore}`)
  reaper = setInterval(() => {
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
      .then(
        (ids) => {
          for (const id of ids) {
            fwd.remove(id)
            reportPlacement('suspended', id)
          }
          if (ids.length) console.log(`[metal-agent] idle-suspended: ${ids.join(', ')}`)
        },
        (err) => console.error('[metal-agent] reaper error:', err?.message ?? err),
      )
  }, config.reapIntervalMs)
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
  if (reaper) clearInterval(reaper)
  if (gc) clearInterval(gc)
  if (pubDataExporter) clearInterval(pubDataExporter)
  await pool.prepareForRestart().catch(() => {})
  process.exit(0)
})
