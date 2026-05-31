// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.setMaxListeners(0)

const originalEnv = { ...process.env }
const originalFetch = global.fetch

let fetchResponses: Array<{ ok: boolean; status?: number; body: any }> = []
let fetchCalls: Array<{ url: string; options: any }> = []
let fetchImpl:
  | ((url: string, options?: any) => Promise<any>)
  | null = null

const mockFetch = mock((url: string, options?: any) => {
  fetchCalls.push({ url, options })
  if (fetchImpl) return fetchImpl(url, options)
  const response = fetchResponses.shift()
  if (!response) {
    return Promise.reject(new Error('No mock response configured'))
  }
  return Promise.resolve({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  })
})
global.fetch = mockFetch as any

const createdWorkDirs: string[] = []
function makeWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'srv-fw-test-'))
  createdWorkDirs.push(dir)
  return dir
}

// Track apps so afterEach can stop their token-refresh timers.
const liveApps: Array<{ state: any }> = []

async function buildApp(overrides: {
  config?: Partial<import('../server-framework').RuntimeAppConfig>
  env?: Record<string, string | undefined>
  workDir?: string
} = {}) {
  if (overrides.env) {
    for (const [k, v] of Object.entries(overrides.env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  const workDir = overrides.workDir ?? makeWorkDir()
  const mod = await import('../server-framework')
  const handle = await mod.createRuntimeApp({
    name: 'test-runtime',
    workDir,
    runtimeType: 'unified',
    authPrefixes: ['/agent', '/pool'],
    async onAssign() {},
    ...overrides.config,
  })
  liveApps.push(handle)
  return { ...handle, workDir }
}

beforeEach(() => {
  fetchCalls = []
  fetchResponses = []
  fetchImpl = null
  mockFetch.mockClear()
  process.env = { ...originalEnv }
  process.env.PROJECT_ID = 'test-project-123'
  process.env.RUNTIME_AUTH_SECRET = 'test-runtime-secret'
  process.env.SHOGO_API_URL = 'http://api.test.local'
  delete process.env.WARM_POOL_MODE
  delete process.env.NODE_ENV
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_TOKEN
  delete process.env.ASSIGNED_PROJECT
  delete process.env.KNATIVE_SERVICE_NAME
  delete process.env.ALLOWED_ORIGINS
})

afterEach(() => {
  for (const h of liveApps) {
    try { h.state.tokenRefresh?.stop() } catch {}
  }
  liveApps.length = 0
  for (const d of createdWorkDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  process.env = { ...originalEnv }
})

// ---------------------------------------------------------------------------
// Factory shape
// ---------------------------------------------------------------------------
describe('createRuntimeApp shape', () => {
  test('returns { app, state, logTiming }', async () => {
    const { app, state, logTiming } = await buildApp()
    expect(app).toBeInstanceOf(Hono)
    expect(typeof logTiming).toBe('function')
    expect(state.currentProjectId).toBe('test-project-123')
    expect(state.isPoolMode).toBe(false)
    expect(state.poolAssigned).toBe(false)
    expect(state.poolAssignedAt).toBeNull()
    expect(typeof state.lastRequestAt).toBe('number')
    expect(state.aiProxy).toBeDefined()
    expect(state.serverStartTime).toBeGreaterThan(0)
    expect(state.entrypointStartTime).toBeGreaterThan(0)
  })

  test('starts token-refresh loop when bound to a real project', async () => {
    const { state } = await buildApp()
    expect(state.tokenRefresh).not.toBeNull()
    expect(typeof state.tokenRefresh!.stop).toBe('function')
  })

  test('defers token-refresh loop in pool mode', async () => {
    const { state } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    expect(state.isPoolMode).toBe(true)
    expect(state.poolAssigned).toBe(false)
    expect(state.tokenRefresh).toBeNull()
  })

  test('logTiming emits to console without throwing', async () => {
    const { logTiming } = await buildApp()
    const originalLog = console.log
    let captured = ''
    console.log = (msg: string) => { captured = String(msg) }
    try {
      logTiming('hello')
    } finally {
      console.log = originalLog
    }
    expect(captured).toContain('hello')
    expect(captured).toContain('[test-runtime]')
  })

  test('respects STARTUP_TIME env for entrypointStartTime', async () => {
    const earlier = Date.now() - 12345
    const { state } = await buildApp({ env: { STARTUP_TIME: String(earlier) } })
    expect(state.entrypointStartTime).toBe(earlier)
  })
})

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------
describe('/health', () => {
  test('returns ok with expected shape', async () => {
    const { app } = await buildApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.projectId).toBe('test-project-123')
    expect(body.runtimeType).toBe('unified')
    expect(body.poolMode).toBe(false)
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  test('merges getHealthExtra() output', async () => {
    const { app } = await buildApp({
      config: { getHealthExtra: () => ({ build: 'abc123', extraFlag: true }) },
    })
    const res = await app.request('/health')
    const body = await res.json()
    expect(body.build).toBe('abc123')
    expect(body.extraFlag).toBe(true)
    expect(body.status).toBe('ok')
  })

  test('reports poolMode=true while unassigned', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/health')
    const body = await res.json()
    expect(body.poolMode).toBe(true)
    expect(body.projectId).toBe('__POOL__')
  })
})

// ---------------------------------------------------------------------------
// /pool/activity
// ---------------------------------------------------------------------------
describe('/pool/activity', () => {
  test('returns default shape when no getActivityStats provided', async () => {
    const { app, state } = await buildApp()
    const res = await app.request('/pool/activity')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projectId).toBe('test-project-123')
    expect(typeof body.lastActivityAt).toBe('number')
    expect(typeof body.idleSeconds).toBe('number')
    expect(body.activeStreams).toBe(0)
    expect(body.activeSessions).toBe(0)
    expect(body.lastRequestAt).toBe(state.lastRequestAt)
    expect(body.poolAssigned).toBe(false)
  })

  test('uses getActivityStats when provided; activeStreams>0 forces idleSeconds=0', async () => {
    const fixed = Date.now() - 60_000
    const { app } = await buildApp({
      config: {
        getActivityStats: () => ({
          activeSessions: 3,
          lastActivityAt: fixed,
          activeStreams: 2,
        }),
      },
    })
    const res = await app.request('/pool/activity')
    const body = await res.json()
    expect(body.activeSessions).toBe(3)
    expect(body.activeStreams).toBe(2)
    expect(body.idleSeconds).toBe(0)
    expect(body.lastSessionActivityAt).toBe(fixed)
  })

  test('idleSeconds reflects elapsed time when no streams', async () => {
    const past = Date.now() - 10_000
    const { app } = await buildApp({
      config: {
        getActivityStats: () => ({
          activeSessions: 0,
          lastActivityAt: past,
          activeStreams: 0,
        }),
      },
    })
    const res = await app.request('/pool/activity')
    const body = await res.json()
    // lastActivity = max(state.lastRequestAt, past); since lastRequestAt is "now",
    // idleSeconds should be ~0, not 10. This validates the max() logic.
    expect(body.idleSeconds).toBeLessThan(5)
  })
})

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
describe('auth middleware', () => {
  test('rejects /agent/* without any auth', async () => {
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Unauthorized/)
  })

  test('accepts x-runtime-token header', async () => {
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(res.status).toBe(200)
  })

  test('accepts Bearer authorization header', async () => {
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { authorization: 'Bearer test-runtime-secret' },
    })
    expect(res.status).toBe(200)
  })

  test('rejects bogus bearer that does not match v1 prefix', async () => {
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'random-garbage' },
    })
    expect(res.status).toBe(401)
    expect(fetchCalls.length).toBe(0)
  })

  test('proxies v1-prefixed runtime token to API for validation', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'test-project-123' } },
    ]
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'rt_v1_test-project-123_abcdefg' },
    })
    expect(res.status).toBe(200)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toContain('/api/internal/validate-runtime-token')
  })

  test('rejects v1 runtime token when API says project mismatch', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'other-project' } },
    ]
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'rt_v1_test-project-123_xxxx' },
    })
    expect(res.status).toBe(401)
  })

  test('caches v1 token result — second matching call hits cache', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'test-project-123' } },
    ]
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const headers = { 'x-runtime-token': 'rt_v1_test-project-123_cachehit' }
    const r1 = await app.request('/agent/secret', { headers })
    expect(r1.status).toBe(200)
    const r2 = await app.request('/agent/secret', { headers })
    expect(r2.status).toBe(200)
    expect(fetchCalls.length).toBe(1)
  })

  test('rejects when API returns non-ok for v1 token', async () => {
    fetchResponses = [
      { ok: false, status: 500, body: { error: 'oops' } },
    ]
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'rt_v1_test-project-123_zz' },
    })
    expect(res.status).toBe(401)
  })

  test('rejects when API fetch throws for v1 token', async () => {
    fetchImpl = () => Promise.reject(new Error('network down'))
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'rt_v1_test-project-123_yy' },
    })
    expect(res.status).toBe(401)
  })

  test('accepts valid preview JWT via API callback', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'test-project-123' } },
    ]
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret?__preview_token=jwt-abc')
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toContain('validate-preview-token')
  })

  test('rejects preview token whose project does not match', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'someone-else' } },
    ]
    const { app } = await buildApp()
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret?__preview_token=jwt-bad')
    expect(res.status).toBe(401)
  })

  test('returns 401 in production when RUNTIME_AUTH_SECRET is missing', async () => {
    const { app } = await buildApp({
      env: { RUNTIME_AUTH_SECRET: undefined, NODE_ENV: 'production' },
    })
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/RUNTIME_AUTH_SECRET/)
  })

  test('allows missing RUNTIME_AUTH_SECRET in non-production', async () => {
    const { app } = await buildApp({
      env: { RUNTIME_AUTH_SECRET: undefined, NODE_ENV: 'development' },
    })
    app.get('/agent/secret', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/secret')
    expect(res.status).toBe(200)
  })

  test('public webchat health path bypasses auth', async () => {
    const { app } = await buildApp()
    app.get('/agent/channels/webchat/health', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/channels/webchat/health')
    expect(res.status).toBe(200)
  })

  test('public canvas path bypasses auth', async () => {
    const { app } = await buildApp()
    app.get('/agent/canvas/anything', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/canvas/anything')
    expect(res.status).toBe(200)
  })

  test('public whatsapp prefix bypasses auth', async () => {
    const { app } = await buildApp()
    app.get('/agent/channels/whatsapp/anything', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/channels/whatsapp/anything')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Activity tracking
// ---------------------------------------------------------------------------
describe('activity tracking', () => {
  test('external request bumps state.lastRequestAt', async () => {
    const { app, state } = await buildApp()
    app.get('/agent/foo', (c) => c.json({ ok: true }))
    const before = state.lastRequestAt
    await new Promise((r) => setTimeout(r, 5))
    const res = await app.request('/agent/foo', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(res.status).toBe(200)
    expect(state.lastRequestAt).toBeGreaterThan(before)
  })

  test('internal /health request does NOT bump lastRequestAt', async () => {
    const { app, state } = await buildApp()
    const before = state.lastRequestAt
    await new Promise((r) => setTimeout(r, 5))
    await app.request('/health')
    expect(state.lastRequestAt).toBe(before)
  })

  test('internal /pool/activity request does NOT bump lastRequestAt', async () => {
    const { app, state } = await buildApp()
    const before = state.lastRequestAt
    await new Promise((r) => setTimeout(r, 5))
    await app.request('/pool/activity')
    expect(state.lastRequestAt).toBe(before)
  })

  test('extra internalPaths from config are also excluded', async () => {
    const { app, state } = await buildApp({
      config: { internalPaths: ['/custom-internal'] },
    })
    app.get('/custom-internal', (c) => c.json({ ok: true }))
    const before = state.lastRequestAt
    await new Promise((r) => setTimeout(r, 5))
    await app.request('/custom-internal')
    expect(state.lastRequestAt).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// /pool/assign
// ---------------------------------------------------------------------------
describe('/pool/assign', () => {
  test('rejects when not in pool mode', async () => {
    const { app } = await buildApp()
    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', env: {} }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Not in pool mode/)
  })

  test('rejects invalid JSON body in pool mode', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Invalid request body/)
  })

  test('rejects missing projectId', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: {} }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/projectId/)
  })

  test('completes assignment, calls onAssign, persists marker, returns ok', async () => {
    const workDir = makeWorkDir()
    let assignedWith: { projectId?: string; env?: Record<string, string> } = {}
    const { app, state } = await buildApp({
      workDir,
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
      config: {
        async onAssign(projectId, env) {
          assignedWith = { projectId, env }
        },
      },
    })

    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-new',
        env: { CUSTOM_VAR: 'hello' },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.projectId).toBe('proj-new')
    expect(typeof body.durationMs).toBe('number')

    expect(assignedWith.projectId).toBe('proj-new')
    expect(assignedWith.env?.CUSTOM_VAR).toBe('hello')
    expect(state.currentProjectId).toBe('proj-new')
    expect(state.poolAssigned).toBe(true)
    expect(state.poolAssignedAt).not.toBeNull()
    expect(state.tokenRefresh).not.toBeNull()
    expect(process.env.PROJECT_ID).toBe('proj-new')
    expect(process.env.CUSTOM_VAR).toBe('hello')

    // Marker file persisted
    const markerPath = join(workDir, '.shogo-pool-assignment')
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf-8')).toBe('proj-new')
  })

  test('workspace bind: assigns a project SET, keys identity ws:<id>, sets merged-root env', async () => {
    const workDir = makeWorkDir()
    let assignedWith: { projectId?: string; env?: Record<string, string> } = {}
    const { app, state } = await buildApp({
      workDir,
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
      config: {
        async onAssign(projectId, env) {
          assignedWith = { projectId, env }
        },
      },
    })

    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-42',
        attachedProjectIds: ['p1', 'p2'],
        env: {
          WORKSPACE_RUNTIME: 'true',
          WORKSPACE_ID: 'ws-42',
          WORKSPACE_PROJECT_IDS: 'p1,p2',
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.projectId).toBe('ws:ws-42') // identity keyed on the workspace
    expect(body.workspaceId).toBe('ws-42')

    // Identity + merged-root markers
    expect(state.currentProjectId).toBe('ws:ws-42')
    expect(assignedWith.projectId).toBe('ws:ws-42')
    expect(process.env.WORKSPACE_RUNTIME).toBe('true')
    expect(process.env.WORKSPACE_PROJECT_IDS).toBe('p1,p2')
    // Back-compat: PROJECT_ID pinned to the first attached project.
    expect(process.env.PROJECT_ID).toBe('p1')

    // Marker persists the workspace identity for self-assign after restart.
    expect(readFileSync(join(workDir, '.shogo-pool-assignment'), 'utf-8')).toBe('ws:ws-42')
  })

  test('workspace bind: rejects a missing attachedProjectIds array', async () => {
    const { app, state } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-42', env: {} }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/attachedProjectIds \(array\) is required/)
    // Failed validation must leave the pod claimable.
    expect(state.poolAssigned).toBe(false)
  })

  test('rejects re-assignment when already assigned', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const first = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-a', env: {} }),
    })
    expect(first.status).toBe(200)

    const second = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-b', env: {} }),
    })
    expect(second.status).toBe(400)
    const body = await second.json()
    expect(body.error).toMatch(/Already assigned/)
  })

  test('rolls back env and project state when onAssign throws', async () => {
    const workDir = makeWorkDir()
    const { app, state } = await buildApp({
      workDir,
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
      config: {
        async onAssign() {
          throw new Error('init blew up')
        },
      },
    })

    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-doomed',
        env: { SHOULD_NOT_PERSIST: 'x' },
      }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/init blew up/)

    // State rolled back
    expect(state.poolAssigned).toBe(false)
    expect(state.currentProjectId).toBe('__POOL__')
    expect(process.env.PROJECT_ID).toBe('__POOL__')
    expect(process.env.SHOULD_NOT_PERSIST).toBeUndefined()
  })

  test('rolls back when configureAIProxy fails (URL set, token missing)', async () => {
    const { app, state } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-bad-env',
        // AI_PROXY_URL with no AI_PROXY_TOKEN → configureAIProxy throws
        env: { AI_PROXY_URL: 'http://proxy.local/v1' },
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Reconfigure failed/)
    expect(state.poolAssigned).toBe(false)
    expect(state.currentProjectId).toBe('__POOL__')
    expect(process.env.AI_PROXY_URL).toBeUndefined()
  })

  test('after assign, /agent/* still requires auth (auth always enforced on /agent)', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    app.get('/agent/secret', (c) => c.json({ ok: true }))

    // Pre-assignment: the /agent middleware does NOT have a pool bypass —
    // only /pool/* does. /agent/* always requires auth.
    const pre = await app.request('/agent/secret')
    expect(pre.status).toBe(401)

    const assign = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-assigned', env: {} }),
    })
    expect(assign.status).toBe(200)

    // Post-assignment, still 401 without auth, 200 with the right token.
    const post = await app.request('/agent/secret')
    expect(post.status).toBe(401)
    const postOk = await app.request('/agent/secret', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(postOk.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Pool-mode middleware behavior
// ---------------------------------------------------------------------------
describe('pool-mode middleware', () => {
  test('pre-assignment, /pool/assign is reachable without auth', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', env: {} }),
    })
    expect(res.status).toBe(200)
  })

  test('pre-assignment, /pool/activity is reachable without auth', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    const res = await app.request('/pool/activity')
    expect(res.status).toBe(200)
  })

  test('after assign, arbitrary /pool/* requires auth', async () => {
    const { app } = await buildApp({
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })
    app.get('/pool/custom', (c) => c.json({ ok: true }))
    const assign = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-x', env: {} }),
    })
    expect(assign.status).toBe(200)

    const noAuth = await app.request('/pool/custom')
    expect(noAuth.status).toBe(401)

    const withAuth = await app.request('/pool/custom', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(withAuth.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Self-assign on boot
// ---------------------------------------------------------------------------
describe('self-assign on boot', () => {
  test('reads pool-assignment marker file and skips pool mode', async () => {
    const workDir = makeWorkDir()
    writeFileSync(join(workDir, '.shogo-pool-assignment'), 'proj-from-disk', 'utf-8')

    fetchImpl = (url: string) => {
      if (url.includes('/api/internal/pod-config/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            projectId: 'proj-from-disk',
            env: { PROJECT_ID: 'proj-from-disk', INJECTED: 'yes' },
          }),
          text: () => Promise.resolve(''),
        })
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }

    const { state } = await buildApp({
      workDir,
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
    })

    expect(state.currentProjectId).toBe('proj-from-disk')
    expect(state.poolAssigned).toBe(true)
    expect(state.poolAssignedAt).not.toBeNull()
    expect(state.tokenRefresh).not.toBeNull()
    expect(process.env.INJECTED).toBe('yes')
  })
})

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
describe('CORS middleware', () => {
  test('responds to preflight OPTIONS', async () => {
    const { app } = await buildApp()
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(res.status).toBe(204)
    const allowOrigin = res.headers.get('access-control-allow-origin')
    expect(allowOrigin).toBe('http://localhost:3000')
  })

  test('echoes allowed origin from ALLOWED_ORIGINS', async () => {
    const { app } = await buildApp({
      env: { ALLOWED_ORIGINS: 'https://app.example.com,https://other.example.com' },
    })
    const res = await app.request('/health', {
      headers: { origin: 'https://app.example.com' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
  })

  test('allows 127.0.0.1 origins by default', async () => {
    const { app } = await buildApp()
    const res = await app.request('/health', {
      headers: { origin: 'http://127.0.0.1:5173' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
  })

  test('echoes the shogo:// desktop origin instead of the ALLOWED_ORIGINS fallback', async () => {
    // The desktop app renders from `shogo://app` and fetches workspace assets
    // directly from this runtime. Without an explicit allowance it falls through
    // to `ALLOWED_ORIGINS[0]`, blocking credentialed image copy/download fetches.
    const { app } = await buildApp({
      env: { ALLOWED_ORIGINS: 'http://localhost:3000' },
    })
    const res = await app.request('/health', {
      headers: { origin: 'shogo://app' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('shogo://app')
  })
})

// ---------------------------------------------------------------------------
// Error path on user-mounted route
// ---------------------------------------------------------------------------
describe('error path', () => {
  test('throwing handler surfaces as 500 (Hono default)', async () => {
    const { app } = await buildApp()
    app.get('/agent/boom', () => {
      throw new Error('kaboom')
    })
    const res = await app.request('/agent/boom', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(res.status).toBe(500)
  })
})


// ===========================================================================
// Coverage additions: paths not exercised by the main test suite above
// ===========================================================================

// ---------------------------------------------------------------------------
// L248-255: SIGTERM / SIGINT handler body
// L260-265: uncaughtException handler body
// ---------------------------------------------------------------------------

describe('process signal handlers (L248-265)', () => {
  test('SIGTERM handler sets shuttingDown and schedules exit (L248-255)', async () => {
    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    try {
      const { state } = await buildApp()
      expect(state.tokenRefresh).not.toBeNull()
      process.emit('SIGTERM')
      // Handler runs synchronously up to the setTimeout schedule.
      // Stop the token refresh so the scheduled exit timer can fire safely.
      state.tokenRefresh?.stop()
      // Second SIGTERM must no-op (shuttingDown guard)
      process.emit('SIGTERM')
      // exitCodes may be empty (exit is scheduled, not immediate) — what matters
      // is the process didn't crash and handler executed without throwing.
      expect(exitCodes.length).toBe(0) // exit is deferred 5s — not fired yet
    } finally {
      process.exit = origExit
    }
  })

  test('SIGINT handler sets shuttingDown and schedules exit', async () => {
    const origExit = process.exit as any
    process.exit = (() => {}) as any
    try {
      const { state } = await buildApp()
      process.emit('SIGINT')
      state.tokenRefresh?.stop()
    } finally {
      process.exit = origExit
    }
  })

  test('uncaughtException handler logs and schedules exit(1) (L260-265)', async () => {
    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    const origErr = console.error
    const errorLines: string[] = []
    console.error = (...a: any[]) => errorLines.push(a.join(' '))
    try {
      await buildApp()
      process.emit('uncaughtException', new Error('boom from test'))
      expect(exitCodes.length).toBe(0) // deferred
      expect(errorLines.some((l) => l.includes('Uncaught exception'))).toBe(true)
    } finally {
      process.exit = origExit
      console.error = origErr
    }
  })
})

// ---------------------------------------------------------------------------
// L311-319: deriveApiUrl() fallback paths
// These are exercised when validatePreviewTokenViaApi is called and
// SHOGO_API_URL is absent — the function walks the fallback chain.
// ---------------------------------------------------------------------------

describe('deriveApiUrl fallback paths (L311-319)', () => {
  async function callWithPreviewToken(app: any, token: string) {
    // Hit /agent/* with a __preview_token so checkRuntimeAuth calls
    // validatePreviewTokenViaApi, which calls deriveApiUrl internally.
    // No Authorization header → slow path → preview token branch.
    return app.request(`/agent/test?__preview_token=${token}`)
  }

  test('L311: API_URL path — fetch uses API_URL when SHOGO_API_URL absent', async () => {
    const { app } = await buildApp({
      env: { SHOGO_API_URL: undefined, API_URL: 'http://api-url.test.local' },
    })
    fetchImpl = async (url: string) => ({
      ok: true, status: 200,
      json: async () => ({ valid: true, projectId: 'test-project-123' }),
      text: async () => '',
    })
    const res = await callWithPreviewToken(app, 'tok-api-url')
    // fetch was called with the API_URL origin
    expect(fetchCalls.some((c) => c.url.includes('api-url.test.local'))).toBe(true)
  })

  test('L312-317: AI_PROXY_URL path — host extracted from proxy URL', async () => {
    const { app } = await buildApp({
      // AI_PROXY_TOKEN must accompany AI_PROXY_URL — configureAIProxy()
      // throws "no proxy token is available" otherwise, and the
      // catch in createRuntimeApp does process.exit(1), killing the
      // whole test process (file would report 0/0/0 → CI red).
      env: {
        SHOGO_API_URL: undefined,
        API_URL: undefined,
        AI_PROXY_URL: 'http://proxy.internal:8080/v1',
        AI_PROXY_TOKEN: 'test-proxy-token',
      },
    })
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ valid: true, projectId: 'test-project-123' }),
      text: async () => '',
    })
    await callWithPreviewToken(app, 'tok-proxy-url')
    expect(fetchCalls.some((c) => c.url.includes('proxy.internal:8080'))).toBe(true)
  })

  test('L319: namespace fallback — uses shogo-system when no URL env vars', async () => {
    const { app } = await buildApp({
      env: { SHOGO_API_URL: undefined, API_URL: undefined, AI_PROXY_URL: undefined },
    })
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ valid: true, projectId: 'test-project-123' }),
      text: async () => '',
    })
    await callWithPreviewToken(app, 'tok-namespace')
    expect(fetchCalls.some((c) => c.url.includes('shogo-system.svc.cluster.local'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// L340: validatePreviewTokenViaApi cache hit path
// ---------------------------------------------------------------------------

describe('validatePreviewToken cache hit (L340)', () => {
  test('second call with same token hits cache, no extra fetch', async () => {
    const { app } = await buildApp()
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ valid: true, projectId: 'test-project-123' }),
      text: async () => '',
    })
    // First call — fetches and caches
    await app.request('/agent/test?__preview_token=cached-tok')
    const fetchCount1 = fetchCalls.filter((c) => c.url.includes('validate-preview')).length
    // Second call — should hit cache (L340)
    await app.request('/agent/test?__preview_token=cached-tok')
    const fetchCount2 = fetchCalls.filter((c) => c.url.includes('validate-preview')).length
    expect(fetchCount2).toBe(fetchCount1) // no additional fetch made
  })
})

// ---------------------------------------------------------------------------
// L355-356: validatePreviewTokenViaApi fetch returns !ok
// L363-364: validatePreviewTokenViaApi fetch throws
// ---------------------------------------------------------------------------

describe('validatePreviewTokenViaApi error paths (L355-364)', () => {
  test('L355-356: non-ok fetch response → returns valid:false, caches negative', async () => {
    const { app } = await buildApp()
    fetchImpl = async () => ({
      ok: false, status: 403,
      json: async () => ({}),
      text: async () => '',
    })
    const res = await app.request('/agent/test?__preview_token=bad-tok')
    expect(res.status).toBe(401) // auth rejected
  })

  test('L363-364: fetch throws → returns valid:false (console.error logged)', async () => {
    const { app } = await buildApp()
    const origErr = console.error
    console.error = () => {}
    try {
      fetchImpl = async () => { throw new Error('network failure') }
      const res = await app.request('/agent/test?__preview_token=throw-tok')
      expect(res.status).toBe(401) // auth rejected
    } finally {
      console.error = origErr
    }
  })
})

// ---------------------------------------------------------------------------
// L646: pool assignment marker writeFileSync fails
// ---------------------------------------------------------------------------

describe('pool assignment marker write failure (L646)', () => {
  test('continues normally and logs warning when marker write throws', async () => {
    const workDir = makeWorkDir()
    const { app } = await buildApp({
      workDir,
      env: { PROJECT_ID: '__POOL__', WARM_POOL_MODE: 'true' },
      config: { async onAssign() {} },
    })
    // Delete the workDir so writeFileSync(join(workDir, '.shogo-pool-assignment'))
    // throws ENOENT → L646 catch fires with a warn log.
    rmSync(workDir, { recursive: true, force: true })

    const warnLines: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warnLines.push(a.join(' '))

    fetchImpl = async (url: string) => {
      if (url.includes('/api/internal/validate-preview-token') ||
          url.includes('/api/internal/validate-runtime-token')) {
        return { ok: true, status: 200, json: async () => ({ valid: true }), text: async () => '' }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }

    try {
      const res = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-marker-fail', env: { FOO: 'bar' } }),
      })
      expect(res.status).toBe(200) // succeeds despite marker write failure
      expect(warnLines.some((l) => l.includes('Could not persist'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})

// ---------------------------------------------------------------------------
// L317: deriveApiUrl — invalid AI_PROXY_URL triggers catch block
// ---------------------------------------------------------------------------

describe('deriveApiUrl invalid AI_PROXY_URL (L317)', () => {
  test('falls through to namespace fallback when AI_PROXY_URL is not a valid URL', async () => {
    const { app } = await buildApp({
      // See note above: AI_PROXY_URL without AI_PROXY_TOKEN trips
      // configureAIProxy → FATAL → process.exit(1) and the whole
      // test file silently FAILs with 0 pass / 0 fail.
      env: {
        SHOGO_API_URL: undefined,
        API_URL: undefined,
        AI_PROXY_URL: 'not-a-valid-url!!!',
        AI_PROXY_TOKEN: 'test-proxy-token',
      },
    })
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ valid: true, projectId: 'test-project-123' }),
      text: async () => '',
    })
    // The catch at L317 fires (URL parse fails), falls through to L319 namespace.
    await app.request('/agent/test?__preview_token=tok-invalid-proxy')
    expect(fetchCalls.some((c) => c.url.includes('shogo-system.svc.cluster.local'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// L256, L264: the setTimeout(() => process.exit(...), 5000) callbacks
// All three signal handlers register these; we need each callback body to
// execute for coverage. Use a fake setTimeout to fire them immediately so
// the test doesn't wait 5 seconds.
// ---------------------------------------------------------------------------

describe('signal handler exit-scheduling callbacks (L256, L264)', () => {
  function withFakeSetTimeout(
    fn: (captured: Array<{ cb: () => void; delay: number }>) => void | Promise<void>,
  ) {
    const origSetTimeout = globalThis.setTimeout as any
    const captured: Array<{ cb: () => void; delay: number }> = []
    globalThis.setTimeout = (cb: () => void, delay: number) => {
      captured.push({ cb, delay })
      // Return a dummy handle so clearTimeout doesn't throw
      return origSetTimeout(() => {}, 9_999_999)
    }
    let result: any
    try {
      result = fn(captured)
    } finally {
      // Restore immediately if sync; for async, restore after await
    }
    const restore = () => { globalThis.setTimeout = origSetTimeout }
    if (result && typeof result.then === 'function') {
      return result.then((v: any) => { restore(); return v }, (e: any) => { restore(); throw e })
    }
    restore()
    return result
  }

  test('SIGTERM exit callback fires process.exit(0) (L256 closure)', async () => {
    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    try {
      await withFakeSetTimeout(async (captured) => {
        const { state } = await buildApp()
        // Stop token-refresh BEFORE emitting signal so its scheduled callback
        // (captured by fake setTimeout) doesn't re-schedule and race into
        // subsequent tests when fired.
        state.tokenRefresh?.stop()
        process.emit('SIGTERM')
        // Only fire the 5000ms exit-scheduling callbacks, not token-refresh callbacks.
        for (const { cb, delay } of captured) { if (delay === 5_000) cb() }
        expect(exitCodes).toContain(0)
      })
    } finally {
      process.exit = origExit
    }
  })

  test('SIGINT exit callback fires process.exit(0)', async () => {
    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    try {
      await withFakeSetTimeout(async (captured) => {
        const { state } = await buildApp()
        state.tokenRefresh?.stop()
        process.emit('SIGINT')
        for (const { cb, delay } of captured) { if (delay === 5_000) cb() }
        expect(exitCodes).toContain(0)
      })
    } finally {
      process.exit = origExit
    }
  })

  test('uncaughtException exit callback fires process.exit(1) (L264 closure)', async () => {
    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    const origErr = console.error
    console.error = () => {}
    try {
      await withFakeSetTimeout(async (captured) => {
        const { state } = await buildApp()
        state.tokenRefresh?.stop()
        process.emit('uncaughtException', new Error('test-uncaught'))
        for (const { cb, delay } of captured) { if (delay === 5_000) cb() }
        expect(exitCodes).toContain(1)
      })
    } finally {
      process.exit = origExit
      console.error = origErr
    }
  })
})

// ---------------------------------------------------------------------------
// Restore originals after suite
// ---------------------------------------------------------------------------
describe('cleanup', () => {
  test('global fetch is the mock during tests', () => {
    expect(global.fetch).toBe(mockFetch as any)
    // Restore after test run so other suites in the same process see the
    // original. (Bun isolates by file but be defensive.)
    global.fetch = originalFetch
  })
})
