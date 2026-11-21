// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — the real two-process stack, standing, for a browser to drive.
 *
 * Boots what `machine-vm-parity.acceptance.test.ts` boots (the cloud `entry.ts`
 * on Postgres + Redis, a desktop `entry.ts` paired to it through `cli/login`, a
 * scripted model the desktop calls), seeds both workspaces, and serves the
 * studio web build (`apps/mobile/dist`, built for the cloud) in front of the
 * cloud, the way the studio image does: same origin, `/api/*` proxied. Then it
 * listens until it is killed.
 *
 *   CHANNELS_TEST_PG_URL=postgresql://… TEST_REDIS_URL=redis://… \
 *     bun --no-env-file apps/api/src/__tests__/helpers/machine-vm-stack.ts
 *
 * `GET /__stack/state` answers the machine, sessions and seeds once everything
 * is up (Playwright's `webServer` waits on it); `GET /__stack/llm?tag=` answers
 * what the scripted model was asked for one turn.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import { httpClient, pairMachine, REPO_ROOT, sessionUserId, startCloud } from './machine-vm-harness'
import { seedWorkspace } from './machine-vm-surfaces'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const WEB_PORT = Number(process.env.E2E_MACHINE_VM_WEB_PORT || 8093)
const WEB_DIST = process.env.E2E_MACHINE_VM_WEB_DIST || join(REPO_ROOT, 'apps/mobile/dist')
const STATE_FILE = process.env.E2E_MACHINE_VM_STATE || join(REPO_ROOT, 'test-results/machine-vm-stack.json')

if (!PG_URL || !REDIS_URL) {
  console.error('machine-vm-stack needs CHANNELS_TEST_PG_URL and TEST_REDIS_URL (or REDIS_URL)')
  process.exit(2)
}
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error(`no web build at ${WEB_DIST}: run \`bun run build\` in apps/mobile first`)
  process.exit(2)
}

const llm = new FakeLlmServer()
await llm.start(0)
/**
 * One browser hammering the SPA trips the API's per-IP limiter (429 "Too many
 * requests") in a way a pod's clients don't: `apps/mobile/nginx.conf` sets
 * `X-Forwarded-For`, so each client gets its own bucket, while everything here
 * arrives from 127.0.0.1. `middleware/rate-limit.ts` has a key for exactly this
 * — the cloud and desktop children inherit it through `processEnv`.
 */
const LOAD_TEST_KEY = randomBytes(16).toString('hex')
process.env.LOAD_TEST_SECRET = LOAD_TEST_KEY
const cloud = await startCloud({ pgServerUrl: PG_URL, redisUrl: REDIS_URL })
const machine = await pairMachine(cloud.base, {
  instanceName: `vm-${Math.random().toString(36).slice(2, 6)}`,
  repoRoot: REPO_ROOT,
  dir: mkdtempSync(join(tmpdir(), 'shogo-vm-desktop-')),
  env: {
    AI_MODE: 'local-llm',
    LOCAL_LLM_BASE_URL: llm.url,
    LOCAL_LLM_BASIC_MODEL: 'fake-stream',
    LOCAL_LLM_ADVANCED_MODEL: 'fake-stream',
  },
}).catch(async (err) => {
  console.error(cloud.log.join('').slice(-4000))
  await cloud.stop()
  throw err
})

const seeds = {
  cloud: await seedWorkspace(httpClient(cloud.base, machine.cookies), machine.cloudWorkspaceId, 'Cloudy'),
  machine: await seedWorkspace(httpClient(machine.localApiBase, machine.localCookies), machine.machineWorkspaceId, 'Machy'),
}
const state = {
  web: `http://127.0.0.1:${WEB_PORT}`,
  cloud: cloud.base,
  cloudUserId: await sessionUserId(cloud.base, machine.cookies),
  localUserId: await sessionUserId(machine.localApiBase, machine.localCookies),
  loadTestKey: LOAD_TEST_KEY,
  ...machine,
  log: undefined,
  seeds,
}
mkdirSync(dirname(STATE_FILE), { recursive: true })
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

const cloudOrigin = new URL(cloud.base).origin

/** `/api/*` to the cloud, as the studio image's nginx does. */
async function proxy(req: Request, url: URL): Promise<Response> {
  const headers = new Headers(req.headers)
  headers.set('host', new URL(cloud.base).host)
  headers.set('x-load-test-key', LOAD_TEST_KEY)
  if (headers.has('origin')) headers.set('origin', cloudOrigin)
  headers.delete('referer')
  const upstream = await fetch(`${cloud.base}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    redirect: 'manual',
  })
  const out = new Headers(upstream.headers)
  // fetch already decoded the body.
  out.delete('content-encoding')
  out.delete('content-length')
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
}

/**
 * SHO-486: team chat opens a WebSocket on `/api/workspaces/:id/rt`, and a
 * `fetch`-only proxy cannot carry the upgrade — the studio page fell back to
 * SSE and a reply the machine wrote never painted. Relay the upgrade the way
 * the desktop API relays the cloud's socket (`routes/local-cloud-proxy.ts`).
 */
const HANDSHAKE_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
])

interface SocketRelay {
  url: string
  headers: Record<string, string>
  upstream?: WebSocket
  pending?: Array<string | BufferSource>
  closed?: boolean
}

function relayHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of req.headers) {
    if (HANDSHAKE_HEADERS.has(name)) continue
    out[name] = name === 'origin' ? cloudOrigin : value
  }
  out['x-load-test-key'] = LOAD_TEST_KEY
  return out
}

/** Close codes a server may send on; anything else becomes 1011. */
function relayCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code < 5000) ? code : 1011
}

const socketRelay = {
  open(ws: any) {
    const data = ws.data as SocketRelay
    data.pending = []
    let upstream: WebSocket
    try {
      upstream = new WebSocket(data.url, { headers: data.headers } as any)
    } catch {
      ws.close(1011, 'cloud_unreachable')
      return
    }
    data.upstream = upstream
    upstream.onopen = () => {
      for (const frame of data.pending ?? []) upstream.send(frame)
      data.pending = []
    }
    upstream.onmessage = (ev) => {
      try {
        ws.send(ev.data as string)
      } catch {
        // The page is closing; its close handler tears the upstream down.
      }
    }
    upstream.onclose = (ev) => {
      if (data.closed) return
      data.closed = true
      try {
        ws.close(relayCloseCode(ev.code), ev.reason)
      } catch {
        /* already closed */
      }
    }
  },
  message(ws: any, raw: string | BufferSource) {
    const data = ws.data as SocketRelay
    if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(raw)
    else data.pending?.push(raw)
  },
  close(ws: any) {
    const data = ws.data as SocketRelay
    data.closed = true
    try {
      data.upstream?.close()
    } catch {
      /* already closed */
    }
  },
}

function staticFile(url: URL): Response {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const candidates = [join(WEB_DIST, rel), join(WEB_DIST, `${rel}.html`), join(WEB_DIST, rel, 'index.html')]
  for (const path of candidates) {
    if (path.startsWith(WEB_DIST) && existsSync(path) && Bun.file(path).size > 0 && !path.endsWith('/')) {
      try {
        return new Response(Bun.file(path))
      } catch {
        /* a directory */
      }
    }
  }
  // Single-page app: every route is index.html.
  return new Response(Bun.file(join(WEB_DIST, 'index.html')), { headers: { 'content-type': 'text/html' } })
}

const server = Bun.serve({
  port: WEB_PORT,
  hostname: '127.0.0.1',
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/__stack/state') return Response.json(state)
    if (url.pathname === '/__stack/llm') return Response.json(llm.requestsFor(url.searchParams.get('tag') ?? ''))
    if (url.pathname.startsWith('/api/')) {
      if (/^websocket$/i.test(req.headers.get('upgrade') ?? '')) {
        const data: SocketRelay = { url: `${cloud.base}${url.pathname}${url.search}`, headers: relayHeaders(req) }
        return srv.upgrade(req, { data }) ? undefined : new Response('websocket upgrade failed', { status: 400 })
      }
      return proxy(req, url)
    }
    return staticFile(url)
  },
  websocket: socketRelay,
})
console.log(`MACHINE_VM_READY ${state.web} (cloud ${cloud.base}, machine ${machine.machineId})`)

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  server.stop(true)
  await machine.stop().catch(() => {})
  await cloud.stop().catch(() => {})
  await llm.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
