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
        return Response.json({ url, mode: r.mode, source: r.source, readyMs: r.readyMs })
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
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const r = await pool.resume(projectId)
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

      return new Response('not found', { status: 404 })
    } catch (err: any) {
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 })
    }
  },
})

console.log(`[metal-agent] listening on http://${config.listenHost}:${server.port}`)
console.log('[metal-agent] warming pool...')
pool.start().then(
  () => {
    console.log('[metal-agent] pool ready')
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
const stopRegistration = startRegistration(pool)

// Idle reaper: fold real guest traffic into idleness (activity poll), then
// quiesce + snapshot assigned VMs that have gone quiet (free host RAM).
let reaper: ReturnType<typeof setInterval> | null = null
if (config.idleSuspendMs > 0) {
  console.log(`[metal-agent] idle-suspend on: idleMs=${config.idleSuspendMs} scan=${config.reapIntervalMs}ms store=${config.snapStore}`)
  reaper = setInterval(() => {
    pool
      .pollActivity()
      .catch(() => {})
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
    pool.gcSweep().then(
      (report) => {
        for (const id of report.evicted) reportPlacement(report.durableRemoved.includes(id) ? 'cold' : 'evicted', id)
      },
      (err) => console.error('[metal-agent] gc error:', err?.message ?? err),
    )
  }, config.gcIntervalMs)
}

process.on('SIGTERM', async () => {
  stopRegistration()
  if (reaper) clearInterval(reaper)
  if (gc) clearInterval(gc)
  fwd.removeAll()
  await pool.stop().catch(() => {})
  process.exit(0)
})
