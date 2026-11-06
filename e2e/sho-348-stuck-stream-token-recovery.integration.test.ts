// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Odin incident, end to end (SHO-348).
 *
 * On 2026-11-05 a metal guest 401'd every model call for ~10 h. The pod sat at
 * `activeStreams: 1` with no turns/tasks for hours: a turn whose model fetch was
 * a dead socket never settled, so the raw counter never decremented, every host
 * idle check read "busy", and the VM was never suspended/resumed — so its expired
 * `AI_PROXY_TOKEN` was never re-pushed. The in-pod refresh loop could not have
 * saved it either: it authenticated with a K8s ServiceAccount token and metal
 * guests have no ServiceAccount file at all.
 *
 * Nothing here is stubbed between the halves that disagreed:
 *
 *   1. The real `StreamBufferStore` / `LiveTurnGate` / `createBufferedTurns` and
 *      the real `StreamRegistry` are wired exactly as `agent-runtime/src/server.ts`
 *      wires them, and the real `createRuntimeApp` serves `/pool/activity`.
 *      A wedged turn must stop making the guest "busy" the moment its turn lock
 *      is dropped, and the reaper must return `activeStreams` to 0 and close the
 *      client's buffer with a terminal frame.
 *   2. The real `startTokenRefreshLoop` runs against a real HTTP endpoint that
 *      verifies `x-runtime-token` with the real `verifyRuntimeToken`, so a metal
 *      guest with no SA token recovers its AI-proxy token and a proxy 401 with an
 *      already-expired token forces exactly one immediate rotation.
 *   3. A model id the registry no longer knows surfaces as a named failure, not
 *      the useless "rejected as malformed" the incident reported.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { StreamBufferStore } from '../packages/shared-runtime/src/stream-buffer'
import { createRuntimeApp } from '../packages/shared-runtime/src/server-framework'
import {
  __resetTokenRefreshGlobals,
  notifyProxyAuthFailure,
  startTokenRefreshLoop,
  type TokenRefreshHandle,
} from '../packages/shared-runtime/src/token-refresh'
import { createBufferedTurns } from '../packages/agent-runtime/src/buffered-turn'
import { LiveTurnGate } from '../packages/agent-runtime/src/live-turn-wait'
import { StreamRegistry } from '../packages/agent-runtime/src/stream-registry'
import { deriveRuntimeToken, verifyRuntimeToken } from '../apps/api/src/lib/runtime-token'
import { buildTurnFailureMessage, classifyTurnFailure } from '../packages/agent/src/retry-classifier'

const decoder = new TextDecoder()
const originalEnv = { ...process.env }

function jwtWithExp(expSecondsFromNow: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out += decoder.decode(value)
  }
}

const PROJECT_ID = '570160e1-odin-email-deliverability'

// ---------------------------------------------------------------------------
// 1. The host can idle a guest whose turn was stopped mid-stream
// ---------------------------------------------------------------------------

describe('a stopped turn does not pin the guest busy forever', () => {
  let store: StreamBufferStore
  let registry: StreamRegistry
  let turns: ReturnType<typeof createBufferedTurns>
  let app: Hono
  let state: any
  let workDir: string
  let now = 1_000_000
  const locked = new Set<string>()
  const logs: string[] = []
  const aborted: string[] = []

  beforeEach(async () => {
    process.env.PROJECT_ID = PROJECT_ID
    delete process.env.WARM_POOL_MODE
    delete process.env.ASSIGNED_PROJECT
    workDir = mkdtempSync(join(tmpdir(), 'sho348-runtime-'))
    store = new StreamBufferStore()
    locked.clear()
    logs.length = 0
    aborted.length = 0
    now = 1_000_000

    registry = new StreamRegistry({
      isTurnLocked: (sessionId) => locked.has(sessionId),
      orphanTtlMs: 10 * 60_000,
      now: () => now,
      log: (line) => logs.push(line),
    })
    const gate = new LiveTurnGate(store, 5)
    turns = createBufferedTurns({
      store,
      gate,
      abortTurn: (sessionId) => aborted.push(sessionId),
      onStreamStart: (handle) => registry.register(handle),
      onStreamProgress: (turnId) => registry.touch(turnId),
      onStreamEnd: (turnId) => registry.end(turnId),
    })

    // Exactly the wiring in packages/agent-runtime/src/server.ts getActivityStats.
    const handle = await createRuntimeApp({
      name: 'sho348-runtime',
      workDir,
      runtimeType: 'unified',
      authPrefixes: ['/agent', '/pool'],
      async onAssign() {},
      getActivityStats: () => {
        const liveStreams = registry.liveCount()
        const busy = liveStreams > 0
        return {
          activeSessions: 0,
          lastActivityAt: state.lastRequestAt,
          activeStreams: registry.size,
          liveStreams,
          busy,
          activeTurns: 0,
          activeTasks: 0,
          activeChildren: 0,
        }
      },
    })
    app = handle.app
    state = handle.state
    try {
      handle.state.tokenRefresh?.stop()
    } catch {
      /* no loop outside a real assignment */
    }
  })

  afterEach(() => {
    try {
      store.dispose()
    } catch {}
    rmSync(workDir, { recursive: true, force: true })
    process.env = { ...originalEnv }
  })

  async function activity() {
    const res = await app.request('/pool/activity')
    expect(res.status).toBe(200)
    return (await res.json()) as { activeStreams: number; liveStreams: number; busy: boolean; idleSeconds: number }
  }

  test('the reported state (activeStreams 1, no turn) is busy only while the turn owns the lock', async () => {
    state.lastRequestAt = Date.now() - 60_000

    // The turn starts and never settles: the dead-socket-after-restore case.
    locked.add('chat-wedged')
    turns.start('chat-wedged', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 10))

    const whileLive = await activity()
    expect(whileLive.activeStreams).toBe(1)
    expect(whileLive.busy).toBe(true)
    expect(whileLive.idleSeconds).toBe(0)

    // The person hit Stop: `abortCurrentTurn` drops the turn lock eagerly while
    // the wedged fetch keeps hanging on (this is what leaked the counter).
    locked.delete('chat-wedged')

    const afterStop = await activity()
    // `activeStreams` is still 1 — the counter did leak, exactly as reported.
    expect(afterStop.activeStreams).toBe(1)
    // The guest is still "busy" only because the stream is inside its orphan
    // TTL (a stopped turn may still be flushing). It is bounded, not forever.
    expect(afterStop.busy).toBe(true)

    // Past the TTL the guest stops claiming to be busy even before the reaper
    // runs, so metal suspends/resumes it and re-pushes env — a fresh
    // AI_PROXY_TOKEN — instead of pinning it for the 10 h the incident saw.
    now += 11 * 60_000
    const afterTtl = await activity()
    expect(afterTtl.activeStreams).toBe(1)
    expect(afterTtl.busy).toBe(false)
    expect(afterTtl.idleSeconds).toBeGreaterThan(30)
  })

  test('the reaper closes the leaked stream and the client gets its terminal frame', async () => {
    state.lastRequestAt = Date.now() - 60_000
    locked.add('chat-wedged')
    turns.start('chat-wedged', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 10))
    locked.delete('chat-wedged')

    // A quiet turn is not reaped inside the TTL.
    now += 9 * 60_000
    expect(registry.reapOrphans()).toEqual([])
    expect((await activity()).activeStreams).toBe(1)

    // Past the TTL it is, loudly, and the runtime is idle again.
    now += 2 * 60_000
    const reaped = registry.reapOrphans()
    expect(reaped).toHaveLength(1)
    expect(aborted).toEqual(['chat-wedged'])
    expect(logs.join('\n')).toContain('reaped orphan stream')

    const after = await activity()
    expect(after.activeStreams).toBe(0)
    expect(after.busy).toBe(false)
    // The reconnecting client stops replaying the tail instead of wedging on Stop.
    const replay = await readAll(store.createReplayStream('chat-wedged', { fromSeq: 0, compact: false })!)
    expect(replay).toContain('data-turn-complete')
    expect(store.snapshot('chat-wedged')?.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// 2. A metal guest (no ServiceAccount token) recovers its AI_PROXY_TOKEN
// ---------------------------------------------------------------------------

describe('a metal guest rotates its AI-proxy token without a ServiceAccount', () => {
  let server: ReturnType<typeof Bun.serve>
  let apiUrl = ''
  let handle: TokenRefreshHandle | null = null
  const seen: Array<{ url: string; auth: string | null; runtimeToken: string | null }> = []
  let issued = 0

  beforeAll(() => {
    process.env.AI_PROXY_SECRET = 'sho348-test-signing-secret'
  })

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.AI_PROXY_SECRET = 'sho348-test-signing-secret'
    process.env.PROJECT_ID = PROJECT_ID
    seen.length = 0
    issued = 0
    __resetTokenRefreshGlobals()

    const app = new Hono()
    // The contract `GET /api/internal/pod-config/:projectId` now implements: a
    // ServiceAccount bearer OR the runtime's own HMAC token. Same verifier.
    app.get('/api/internal/pod-config/:projectId', (c) => {
      const projectId = c.req.param('projectId')
      const runtimeToken = c.req.header('x-runtime-token')
      seen.push({ url: c.req.path, auth: c.req.header('Authorization') ?? null, runtimeToken: runtimeToken ?? null })
      const verified = runtimeToken ? verifyRuntimeToken(runtimeToken, projectId) : { ok: false as const }
      if (!verified.ok || verified.projectId !== projectId) {
        return c.json({ error: 'Missing or invalid Authorization header' }, 401)
      }
      issued++
      return c.json({ projectId, env: { AI_PROXY_TOKEN: jwtWithExp(7 * 24 * 3600) } })
    })
    server = Bun.serve({ port: 0, fetch: app.fetch })
    apiUrl = `http://127.0.0.1:${server.port}`
    process.env.SHOGO_API_URL = apiUrl
    delete process.env.K8S_SA_TOKEN_OVERRIDE
  })

  afterEach(() => {
    try {
      handle?.stop()
    } catch {}
    handle = null
    try {
      server?.stop(true)
    } catch {}
    __resetTokenRefreshGlobals()
    process.env = { ...originalEnv }
  })

  test('the loop sends x-runtime-token and applies the rotated token', async () => {
    process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(PROJECT_ID)
    process.env.AI_PROXY_TOKEN = jwtWithExp(-60) // the expired token from the incident

    handle = startTokenRefreshLoop({
      getProjectId: () => PROJECT_ID,
      logPrefix: 'sho348-loop',
      intervalMs: 60 * 60_000,
      jitterMs: 0,
    })

    const env = await handle.refreshNow()
    expect(env?.AI_PROXY_TOKEN).toBeTruthy()
    expect(process.env.AI_PROXY_TOKEN).toBe(env!.AI_PROXY_TOKEN)
    expect(seen).toHaveLength(1)
    expect(seen[0].auth).toBeNull() // no SA token on metal
    expect(seen[0].runtimeToken).toBe(deriveRuntimeToken(PROJECT_ID))
    expect(issued).toBe(1)
  })

  test('a proxy 401 with an expired local token forces exactly one immediate rotation', async () => {
    process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(PROJECT_ID)
    process.env.AI_PROXY_TOKEN = jwtWithExp(-60)

    handle = startTokenRefreshLoop({
      getProjectId: () => PROJECT_ID,
      logPrefix: 'sho348-loop',
      intervalMs: 60 * 60_000,
      jitterMs: 0,
    })

    expect(notifyProxyAuthFailure()).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(issued).toBe(1)

    // A burst of 401s from other sessions must not storm the API.
    expect(notifyProxyAuthFailure()).toBe(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(issued).toBe(1)

    // And a still-valid token means the 401 was not a rotation problem.
    process.env.AI_PROXY_TOKEN = jwtWithExp(3600)
    __resetTokenRefreshGlobals()
    handle.stop()
    handle = startTokenRefreshLoop({
      getProjectId: () => PROJECT_ID,
      logPrefix: 'sho348-loop',
      intervalMs: 60 * 60_000,
      jitterMs: 0,
    })
    expect(notifyProxyAuthFailure()).toBe(false)
    expect(issued).toBe(1)
  })

  test('a wrong runtime token is rejected — the fix is auth, not a bypass', async () => {
    process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken('some-other-project')
    const expired = jwtWithExp(-60)
    process.env.AI_PROXY_TOKEN = expired

    handle = startTokenRefreshLoop({
      getProjectId: () => PROJECT_ID,
      logPrefix: 'sho348-loop',
      intervalMs: 60 * 60_000,
      jitterMs: 0,
    })

    expect(await handle.refreshNow()).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0].auth).toBeNull()
    expect(issued).toBe(0)
    expect(process.env.AI_PROXY_TOKEN).toBe(expired)
  })
})

// ---------------------------------------------------------------------------
// 3. A deleted model id names itself instead of saying "malformed"
// ---------------------------------------------------------------------------

describe('a deleted model id', () => {
  // The body `apps/api/src/routes/ai-proxy.ts` really returns for a model id the
  // registry no longer has, as the agent sees it.
  const raw =
    'Provider error: 400 {"error":{"message":"Model \'e484818f-0c1e-4e3e-9d28-6d2e0f0dd2c1\' is not supported. Use GET /ai/v1/models to see available models.","type":"invalid_request_error","code":"model_not_found"}}'

  test('classifies as model_not_found, not invalid_request', () => {
    expect(classifyTurnFailure({ rawError: raw })).toBe('model_not_found')
    expect(classifyTurnFailure({ rawError: raw })).not.toBe('invalid_request')
  })

  test('tells the person which model to replace', () => {
    const message = buildTurnFailureMessage(classifyTurnFailure({ rawError: raw }), 0, {
      modelName: 'e484818f-0c1e-4e3e-9d28-6d2e0f0dd2c1',
    })
    expect(message).toContain('e484818f-0c1e-4e3e-9d28-6d2e0f0dd2c1')
    expect(message).toContain('no longer available')
    expect(message).not.toContain('malformed')
  })
})
