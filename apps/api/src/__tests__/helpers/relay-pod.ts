// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One API pod, for the two-pod relay test (SHO-185).
 *
 * Runs the *real* `routes/instances` module against a real Redis, so the test
 * exercises ownership registration, the liveness probe, the pub/sub relay and
 * the eviction policy exactly as production does — the previous relay tests all
 * mocked Redis, which is why a wrong eviction shipped.
 *
 *   bun relay-pod.ts owner <instanceId>       hold a tunnel and answer relays
 *   bun relay-pod.ts requester <instanceId>   send one request, print the result
 *
 * Env: POD_ID (HOSTNAME), REDIS_URL, ANSWER_DELAY_MS ('never' to hang),
 * ANSWER_BODY, SHOGO_PROXY_TIMEOUT_MS, SHOGO_RELAY_GRACE_MS.
 */

const role = process.argv[2]
const instanceId = process.argv[3]
const requestedPath = process.argv[4] || '/api/local/machine'
const answerDelay = process.env.ANSWER_DELAY_MS || '0'
const answerBody = process.env.ANSWER_BODY || 'pong-from-desktop'

const { sendTunnelRequest, instanceRoutes, _testing } = await import('../../routes/instances')
const { registerTunnelOwnership } = await import('../../lib/tunnel-redis')

function respond(conn: any, req: any) {
  // A path ending in `/never` models a desktop that accepted the request and
  // then wedged — the case that used to evict a live tunnel's owner.
  if (answerDelay === 'never' || String(req.path).includes('/never')) return
  setTimeout(() => {
    const pending = conn.pendingRequests.get(req.requestId)
    if (!pending) return
    clearTimeout(pending.timeout)
    conn.pendingRequests.delete(req.requestId)
    pending.resolve({ status: 200, body: answerBody, headers: { 'content-type': 'text/plain' } })
  }, Number(answerDelay))
}

if (role === 'owner') {
  // The real wiring: `instanceRoutes()` is what registers the pod's local relay
  // handlers in production, so without this the pod accepts relay requests and
  // silently drops them.
  instanceRoutes()
  const conn: any = {
    ws: {
      sent: [] as string[],
      send: (data: string) => {
        conn.ws.sent.push(data)
        const req = JSON.parse(data)
        if (req.type === 'request') respond(conn, req)
      },
      close: () => {},
    },
    workspaceId: 'ws-owner',
    userId: 'user-owner',
    instanceId,
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  }
  ;(_testing.tunnels as Map<string, any>).set(instanceId, conn)
  await registerTunnelOwnership(instanceId)
  console.log('READY')
  // Stay alive to serve relays. Not stdin: a spawned worker may have its stdin
  // closed immediately, and the owner must outlive that until the parent kills it.
  const keepAlive = setInterval(() => {}, 1_000)
  const shutdown = () => {
    clearInterval(keepAlive)
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} else {
  const requestId = `req-${process.pid}`
  try {
    const res = await sendTunnelRequest(instanceId, {
      type: 'request',
      requestId,
      method: 'GET',
      path: requestedPath,
      headers: {},
    } as any)
    console.log(JSON.stringify({ ok: true, status: res.status, body: res.body }))
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, code: err?.code ?? null, message: err?.message ?? String(err) }))
  }
  process.exit(0)
}
