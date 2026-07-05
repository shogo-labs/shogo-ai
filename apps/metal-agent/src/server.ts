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
import { MetalWarmPool } from './pool'
import { startRegistration } from './register'

const pool = new MetalWarmPool()

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

      if (path === '/assign' && req.method === 'POST') {
        const { projectId, env } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        // Wake path if a snapshot exists (hot local OR durable store); a stale/
        // cold miss returns null → fall back to a fresh warm assign.
        if (await pool.canResume(projectId)) {
          const r = await pool.resume(projectId)
          if (r) return Response.json({ url: r.assigned.handle.agentUrl, mode: 'resumed', source: r.source, readyMs: r.readyMs })
        }
        const a = await pool.assign(projectId, env ?? {})
        return Response.json({ url: a.handle.agentUrl, mode: 'assigned' })
      }

      if (path === '/suspend' && req.method === 'POST') {
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const s = await pool.suspend(projectId)
        return Response.json({ ok: true, memBytes: s.snapshot.bytesMem })
      }

      if (path === '/resume' && req.method === 'POST') {
        const { projectId } = await json(req)
        if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
        const r = await pool.resume(projectId)
        if (!r) return Response.json({ error: 'no restorable snapshot (cold miss)' }, { status: 409 })
        return Response.json({ url: r.assigned.handle.agentUrl, source: r.source, readyMs: r.readyMs })
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
  () => console.log('[metal-agent] pool ready'),
  (err) => console.error('[metal-agent] pool warmup failed:', err?.message ?? err),
)

// Announce this host to the control plane over the mesh (no-op if unconfigured).
const stopRegistration = startRegistration(pool)

// Idle reaper: quiesce + snapshot assigned VMs that go quiet (free host RAM).
let reaper: ReturnType<typeof setInterval> | null = null
if (config.idleSuspendMs > 0) {
  console.log(`[metal-agent] idle-suspend on: idleMs=${config.idleSuspendMs} scan=${config.reapIntervalMs}ms store=${config.snapStore}`)
  reaper = setInterval(() => {
    pool.reapIdle().then(
      (ids) => ids.length && console.log(`[metal-agent] idle-suspended: ${ids.join(', ')}`),
      (err) => console.error('[metal-agent] reaper error:', err?.message ?? err),
    )
  }, config.reapIntervalMs)
}

process.on('SIGTERM', async () => {
  stopRegistration()
  if (reaper) clearInterval(reaper)
  await pool.stop().catch(() => {})
  process.exit(0)
})
