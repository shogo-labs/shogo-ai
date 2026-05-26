// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage additions for server-framework.ts — paths that require mocking
 * the ../ai-proxy module (the SDK dist ships a stub that never throws/enables
 * the proxy, so these branches are unreachable without a module replacement).
 *
 * Lines covered:
 *   L150-151  !currentProjectId → process.exit(1)
 *   L188-189  configureAIProxy throws → process.exit(1) at boot
 *   L194      aiProxy.useProxy → Object.assign(process.env, aiProxy.env)
 *   L627-629  pool/assign: configureAIProxy throws → rollback + 400
 *   L633      pool/assign: aiProxy.useProxy → env spreading
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// ai-proxy mock state — declared BEFORE mock.module so factory closes over ref
// ---------------------------------------------------------------------------

type AiProxyMode = 'ok-no-proxy' | 'ok-use-proxy' | 'throw'
let _aiProxyMode: AiProxyMode = 'ok-no-proxy'

mock.module('../ai-proxy', () => ({
  configureAIProxy: (_opts?: unknown) => {
    if (_aiProxyMode === 'throw') {
      throw new Error('AI_PROXY_URL is set but no proxy token is available')
    }
    if (_aiProxyMode === 'ok-use-proxy') {
      return { useProxy: true, env: { AI_PROXY_ACTIVE: 'yes', AI_PROXY_URL: 'http://proxy' } }
    }
    return { useProxy: false, env: {} }
  },
}))

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

let _fetchImpl: ((url: string, opts?: any) => Promise<any>) | null = null
const _mockFetch = mock((url: string, opts?: any) => {
  if (_fetchImpl) return _fetchImpl(url, opts)
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
})
global.fetch = _mockFetch as any

// ---------------------------------------------------------------------------
// Import server-framework AFTER mocks
// ---------------------------------------------------------------------------

import { createRuntimeApp } from '../server-framework'

// ---------------------------------------------------------------------------

const _createdDirs: string[] = []
function _mkDir() {
  const d = mkdtempSync(join(tmpdir(), 'sf-mock-'))
  _createdDirs.push(d)
  return d
}

const _liveStates: Array<{ tokenRefresh?: { stop(): void } | null }> = []

beforeEach(() => {
  _aiProxyMode = 'ok-no-proxy'
  _fetchImpl = null
  _mockFetch.mockClear()
  process.env.PROJECT_ID = 'test-project-123'
  process.env.RUNTIME_AUTH_SECRET = 'test-secret'
  process.env.SHOGO_API_URL = 'http://api.test.local'
  delete process.env.WARM_POOL_MODE
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_ACTIVE
})

afterEach(() => {
  for (const s of _liveStates.splice(0)) {
    try { s.tokenRefresh?.stop() } catch {}
  }
  for (const d of _createdDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  delete process.env.AI_PROXY_ACTIVE
})

// ---------------------------------------------------------------------------
// L150-151: missing PROJECT_ID → process.exit(1)
// ---------------------------------------------------------------------------

describe('missing PROJECT_ID → process.exit(1) (L150-151)', () => {
  test('records exit(1) and logs error when PROJECT_ID is absent', async () => {
    delete process.env.PROJECT_ID

    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    const errLines: string[] = []
    const origErr = console.error
    console.error = (...a: any[]) => errLines.push(a.join(' '))
    try {
      // createRuntimeApp calls process.exit(1) synchronously when PROJECT_ID absent.
      // Since exit is mocked (no-op), execution continues and may hit downstream
      // code with undefined state — catch that to prevent test failure.
      await createRuntimeApp({
        name: 'test-no-pid',
        workDir: _mkDir(),
        runtimeType: 'unified',
        authPrefixes: [],
        async onAssign() {},
      }).catch(() => { /* TypeError from continuing after mocked exit is expected */ })
      expect(exitCodes).toContain(1)
      expect(errLines.some((l) => l.includes('PROJECT_ID'))).toBe(true)
    } finally {
      process.exit = origExit
      console.error = origErr
    }
  })
})

// ---------------------------------------------------------------------------
// L188-189: configureAIProxy throws at boot → process.exit(1)
// ---------------------------------------------------------------------------

describe('configureAIProxy throws at boot → process.exit(1) (L188-189)', () => {
  test('records exit(1) and logs FATAL when configureAIProxy throws', async () => {
    _aiProxyMode = 'throw'

    const origExit = process.exit as any
    const exitCodes: number[] = []
    process.exit = ((code: number) => { exitCodes.push(code) }) as any
    const errLines: string[] = []
    const origErr = console.error
    console.error = (...a: any[]) => errLines.push(a.join(' '))
    try {
      await createRuntimeApp({
        name: 'test-aiproxy-throw',
        workDir: _mkDir(),
        runtimeType: 'unified',
        authPrefixes: [],
        async onAssign() {},
      }).catch(() => { /* TypeError expected when mocked exit doesn't stop execution */ })
      expect(exitCodes).toContain(1)
      expect(errLines.some((l) => l.includes('FATAL'))).toBe(true)
    } finally {
      process.exit = origExit
      console.error = origErr
    }
  })
})

// ---------------------------------------------------------------------------
// L194: aiProxy.useProxy=true → Object.assign(process.env, aiProxy.env)
// ---------------------------------------------------------------------------

describe('aiProxy.useProxy=true → env spreading at boot (L194)', () => {
  test('merges aiProxy.env into process.env when useProxy is true', async () => {
    _aiProxyMode = 'ok-use-proxy'
    delete process.env.AI_PROXY_ACTIVE

    const { state } = await createRuntimeApp({
      name: 'test-useproxy',
      workDir: _mkDir(),
      runtimeType: 'unified',
      authPrefixes: [],
      async onAssign() {},
    })
    _liveStates.push(state)

    expect(state.aiProxy.useProxy).toBe(true)
    expect(process.env.AI_PROXY_ACTIVE).toBe('yes')
  })
})

// ---------------------------------------------------------------------------
// L627-629: pool/assign — configureAIProxy throws → rollback + 400
// ---------------------------------------------------------------------------

describe('pool/assign configureAIProxy throws → rollback 400 (L627-629)', () => {
  test('returns 400 and rolls back env when configureAIProxy throws during assign', async () => {
    // Boot in pool mode (configureAIProxy works fine at boot — pool mode defers it)
    process.env.PROJECT_ID = '__POOL__'
    process.env.WARM_POOL_MODE = 'true'

    const { app, state } = await createRuntimeApp({
      name: 'test-pool-cfgthrow',
      workDir: _mkDir(),
      runtimeType: 'unified',
      authPrefixes: [],
      async onAssign() {},
    })
    _liveStates.push(state)

    // Now make configureAIProxy throw for the /pool/assign call
    _aiProxyMode = 'throw'

    const errLines: string[] = []
    const origErr = console.error
    console.error = (...a: any[]) => errLines.push(a.join(' '))
    try {
      const res = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-rollback', env: {} }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Reconfigure failed/)
      expect(errLines.some((l) => l.includes('reconfigure failed') || l.includes('Reconfigure'))).toBe(true)
    } finally {
      console.error = origErr
    }
  })
})

// ---------------------------------------------------------------------------
// L633: pool/assign — aiProxy.useProxy=true → env spreading
// ---------------------------------------------------------------------------

describe('pool/assign aiProxy.useProxy=true → env spread (L633)', () => {
  test('spreads aiProxy.env into process.env after successful pool assign', async () => {
    // Boot in pool mode
    process.env.PROJECT_ID = '__POOL__'
    process.env.WARM_POOL_MODE = 'true'

    const { app, state } = await createRuntimeApp({
      name: 'test-pool-useproxy',
      workDir: _mkDir(),
      runtimeType: 'unified',
      authPrefixes: [],
      async onAssign() {},
    })
    _liveStates.push(state)

    // configureAIProxy returns useProxy=true during the assign call
    _aiProxyMode = 'ok-use-proxy'
    delete process.env.AI_PROXY_ACTIVE

    const res = await app.request('/pool/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-useproxy',
        env: { PROJECT_ID: 'proj-useproxy' },
      }),
    })
    expect(res.status).toBe(200)
    expect(process.env.AI_PROXY_ACTIVE).toBe('yes') // spread from aiProxy.env
  })
})
