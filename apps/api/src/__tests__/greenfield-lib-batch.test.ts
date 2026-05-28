// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Greenfield batch coverage for four small previously-untested files:
//
//   - src/lib/strip-orphan-tool-parts.ts          (84 lines, 0 tests)
//   - src/lib/kourier-lb-discovery.ts             (92 lines, 0 tests)
//   - src/middleware/marketplace-feature.ts       (112 lines, 0 tests)
//   - src/routes/project-auth-config.ts           (106 lines, 0 tests)
//
// All four files mounted into apps/api but never directly imported by
// any existing test — only the module-load constants were counted.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ============================================================================
// strip-orphan-tool-parts.ts — pure-function test
// ============================================================================

import { stripOrphanToolParts } from '../lib/strip-orphan-tool-parts'

describe('stripOrphanToolParts', () => {
  test('returns input unchanged when no tool parts present', () => {
    const msgs = [
      { id: '1', role: 'user' as const, parts: [{ type: 'text', text: 'hi' }] },
      { id: '2', role: 'assistant' as const, parts: [{ type: 'text', text: 'hey' }] },
    ] as never
    const r = stripOrphanToolParts(msgs)
    expect(r.droppedCount).toBe(0)
    expect(r.messages).toHaveLength(2)
  })

  test('drops tool-* parts with non-complete state', () => {
    const msgs = [
      {
        id: '1',
        role: 'assistant' as const,
        parts: [
          { type: 'text', text: 'before' },
          { type: 'tool-search', state: 'input-streaming' }, // orphan
          { type: 'text', text: 'after' },
        ],
      },
    ] as never
    const r = stripOrphanToolParts(msgs)
    expect(r.droppedCount).toBe(1)
    expect(r.messages[0]!.parts).toHaveLength(2)
  })

  test('keeps tool parts in complete states (output-available/error/denied)', () => {
    const states = ['output-available', 'output-error', 'output-denied']
    for (const state of states) {
      const r = stripOrphanToolParts([
        {
          id: '1',
          role: 'assistant' as const,
          parts: [{ type: 'tool-x', state }],
        },
      ] as never)
      expect(r.droppedCount).toBe(0)
      expect(r.messages[0]!.parts).toHaveLength(1)
    }
  })

  test('drops entire message if all parts were orphans', () => {
    const msgs = [
      { id: 'keep', role: 'user' as const, parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'drop',
        role: 'assistant' as const,
        parts: [{ type: 'tool-x', state: 'input-available' }],
      },
    ] as never
    const r = stripOrphanToolParts(msgs)
    expect(r.droppedCount).toBe(1)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]!.id).toBe('keep')
  })

  test('passes through messages with no parts array / empty parts', () => {
    const r = stripOrphanToolParts([
      { id: '1', role: 'user' as const } as never,
      { id: '2', role: 'user' as const, parts: [] } as never,
    ])
    expect(r.droppedCount).toBe(0)
    expect(r.messages).toHaveLength(2)
  })

  test('dynamic-tool type also subject to the orphan check', () => {
    const r = stripOrphanToolParts([
      {
        id: '1',
        role: 'assistant' as const,
        parts: [
          { type: 'dynamic-tool', state: 'input-streaming' }, // orphan
          { type: 'dynamic-tool', state: 'output-available' }, // keep
        ],
      },
    ] as never)
    expect(r.droppedCount).toBe(1)
    expect(r.messages[0]!.parts).toHaveLength(1)
  })

  test('non-object parts are passed through (defensive)', () => {
    const r = stripOrphanToolParts([
      { id: '1', role: 'user' as const, parts: ['raw-string-part'] } as never,
    ])
    expect(r.droppedCount).toBe(0)
    expect(r.messages[0]!.parts).toHaveLength(1)
  })

  test('tool part with missing state is treated as orphan', () => {
    const r = stripOrphanToolParts([
      {
        id: '1',
        role: 'assistant' as const,
        parts: [{ type: 'tool-x' }], // no state at all
      },
    ] as never)
    expect(r.droppedCount).toBe(1)
    expect(r.messages).toHaveLength(0) // empty msg dropped
  })
})

// ============================================================================
// kourier-lb-discovery.ts — needs @kubernetes/client-node + fs mocks
// ============================================================================

const k8sState: {
  caExists: boolean
  tokenExists: boolean
  ingress: Array<{ ip?: string; hostname?: string }>
  readShouldThrow: boolean
} = {
  caExists: false,
  tokenExists: false,
  ingress: [],
  readShouldThrow: false,
}

mock.module('fs', () => ({
  existsSync: (p: string) => {
    if (p.endsWith('/ca.crt')) return k8sState.caExists
    if (p.endsWith('/token')) return k8sState.tokenExists
    return false
  },
  readFileSync: () => 'fake-bytes',
}))

mock.module('@kubernetes/client-node', () => {
  class FakeCoreV1Api {
    async readNamespacedService() {
      if (k8sState.readShouldThrow) throw new Error('k8s API unavailable')
      return { status: { loadBalancer: { ingress: k8sState.ingress } } }
    }
  }
  class FakeKubeConfig {
    loadFromOptions() {}
    loadFromDefault() {}
    makeApiClient() { return new FakeCoreV1Api() }
  }
  return { KubeConfig: FakeKubeConfig, CoreV1Api: FakeCoreV1Api }
})

const { discoverKourierLbIp, _resetKourierLbDiscoveryForTest } =
  await import('../lib/kourier-lb-discovery')

beforeEach(() => {
  _resetKourierLbDiscoveryForTest()
  k8sState.caExists = false
  k8sState.tokenExists = false
  k8sState.ingress = []
  k8sState.readShouldThrow = false
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.KUBERNETES_SERVICE_PORT
})

describe('discoverKourierLbIp', () => {
  test('returns first ingress.ip when present', async () => {
    k8sState.ingress = [{ ip: '203.0.113.5' }]
    const ip = await discoverKourierLbIp()
    expect(ip).toBe('203.0.113.5')
  })

  test('returns null when ingress is empty (LB not provisioned yet)', async () => {
    k8sState.ingress = []
    const ip = await discoverKourierLbIp()
    expect(ip).toBeNull()
  })

  test('throws when ingress is hostname-only (no IPv4)', async () => {
    k8sState.ingress = [{ hostname: 'k8s.example.com' }]
    await expect(discoverKourierLbIp()).rejects.toThrow(/hostname-only ingress/)
  })

  test('throws when K8s API fails (RBAC/network)', async () => {
    k8sState.readShouldThrow = true
    await expect(discoverKourierLbIp()).rejects.toThrow(/k8s API unavailable/)
  })

  test('reads in-cluster service account when CA + token files exist', async () => {
    k8sState.caExists = true
    k8sState.tokenExists = true
    k8sState.ingress = [{ ip: '198.51.100.1' }]
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    const ip = await discoverKourierLbIp()
    expect(ip).toBe('198.51.100.1')
  })

  test('falls back to loadFromDefault when SA dir absent', async () => {
    k8sState.ingress = [{ ip: '10.0.0.5' }]
    const ip = await discoverKourierLbIp()
    expect(ip).toBe('10.0.0.5')
  })

  test('caches CoreV1Api across calls (second call uses cached client)', async () => {
    k8sState.ingress = [{ ip: '1.2.3.4' }]
    const ip1 = await discoverKourierLbIp()
    const ip2 = await discoverKourierLbIp()
    expect(ip1).toBe('1.2.3.4')
    expect(ip2).toBe('1.2.3.4')
  })
})

// ============================================================================
// marketplace-feature.ts — middleware with prisma + cache
// ============================================================================

const settingState: {
  value: string | null
  shouldThrow: boolean
} = { value: null, shouldThrow: false }

mock.module('../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async () => {
        if (settingState.shouldThrow) throw new Error('prisma down')
        if (settingState.value === null) return null
        return { value: settingState.value }
      },
    },
  },
}))

const mf = await import('../middleware/marketplace-feature')

beforeEach(() => {
  mf._resetMarketplaceFeatureCacheForTests()
  settingState.value = null
  settingState.shouldThrow = false
  delete process.env.NODE_ENV
  delete process.env.SHOGO_LOCAL_MODE
})

describe('isMarketplaceEnabled', () => {
  test('returns true when row.value === "true"', async () => {
    settingState.value = 'true'
    expect(await mf.isMarketplaceEnabled()).toBe(true)
  })

  test('returns false when row.value !== "true"', async () => {
    settingState.value = 'false'
    expect(await mf.isMarketplaceEnabled()).toBe(false)
  })

  test('returns false when row is absent (fail-closed default)', async () => {
    settingState.value = null
    expect(await mf.isMarketplaceEnabled()).toBe(false)
  })

  test('fails closed when prisma throws', async () => {
    settingState.shouldThrow = true
    const origError = console.error
    console.error = () => {}
    try {
      expect(await mf.isMarketplaceEnabled()).toBe(false)
    } finally {
      console.error = origError
    }
  })

  test('honours 15s cache TTL', async () => {
    settingState.value = 'true'
    const now0 = 1_000_000_000_000
    const v1 = await mf.isMarketplaceEnabled(now0)
    settingState.value = 'false' // flip the source under our feet
    const v2 = await mf.isMarketplaceEnabled(now0 + 1000)
    const v3 = await mf.isMarketplaceEnabled(now0 + 16_000)
    expect(v1).toBe(true)
    expect(v2).toBe(true) // cache hit; source flip not seen
    expect(v3).toBe(false) // cache expired
  })
})

describe('requireMarketplaceFeature middleware', () => {
  function fakeCtx() {
    let jsonBody: unknown = null
    let jsonStatus = 200
    return {
      json: (b: unknown, s = 200) => {
        jsonBody = b
        jsonStatus = s
        return { _body: b, _status: s }
      },
      _getResponse: () => ({ jsonBody, jsonStatus }),
    } as never
  }

  test('NODE_ENV=test bypasses the gate', async () => {
    process.env.NODE_ENV = 'test'
    const c = fakeCtx()
    let nextCalled = false
    await mf.requireMarketplaceFeature(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  test('SHOGO_LOCAL_MODE=true bypasses the gate', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SHOGO_LOCAL_MODE = 'true'
    const c = fakeCtx()
    let nextCalled = false
    await mf.requireMarketplaceFeature(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  test('flag disabled → 503 marketplace_disabled', async () => {
    process.env.NODE_ENV = 'production'
    settingState.value = 'false'
    const c = fakeCtx()
    let nextCalled = false
    await mf.requireMarketplaceFeature(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    const { jsonStatus, jsonBody } = (c as never as { _getResponse: () => {jsonStatus:number; jsonBody:unknown}})._getResponse()
    expect(jsonStatus).toBe(503)
    expect((jsonBody as { error: { code: string } }).error.code).toBe('marketplace_disabled')
  })

  test('flag enabled → calls next()', async () => {
    process.env.NODE_ENV = 'production'
    settingState.value = 'true'
    const c = fakeCtx()
    let nextCalled = false
    await mf.requireMarketplaceFeature(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })
})

// ============================================================================
// project-auth-config.ts (route) — drives the 4 endpoints via Hono
// ============================================================================

// Mock the service the route delegates to
const svcState: {
  config: Record<string, unknown>
  upsertThrows: 'never' | 'project_auth_error' | 'generic'
  users: Array<Record<string, unknown>>
  nextCursor: string | null
  revokedKeys: string[]
} = {
  config: { mode: 'anyone', allowedEmails: [], allowedDomains: [], requireEmailVerification: false },
  upsertThrows: 'never',
  users: [],
  nextCursor: null,
  revokedKeys: [],
}

class TestProjectAuthConfigError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProjectAuthConfigError'
    this.code = code
  }
}

mock.module('../services/project-auth-config.service', () => ({
  ProjectAuthConfigError: TestProjectAuthConfigError,
  getConfig: async () => svcState.config,
  upsertConfig: async (_projectId: string, body: Record<string, unknown>) => {
    if (svcState.upsertThrows === 'project_auth_error') {
      throw new TestProjectAuthConfigError('invalid_mode', 'mode must be anyone|custom|workspace')
    }
    if (svcState.upsertThrows === 'generic') {
      throw new Error('something exploded')
    }
    return { ...svcState.config, ...body }
  },
  listUsers: async (_projectId: string, _opts: unknown) => ({
    items: svcState.users,
    nextCursor: svcState.nextCursor,
  }),
  revokeUser: async (projectId: string, userId: string) => {
    svcState.revokedKeys.push(`${projectId}:${userId}`)
  },
}))

const { projectAuthConfigRoutes } = await import('../routes/project-auth-config')

beforeEach(() => {
  svcState.config = {
    mode: 'anyone',
    allowedEmails: [],
    allowedDomains: [],
    requireEmailVerification: false,
  }
  svcState.upsertThrows = 'never'
  svcState.users = []
  svcState.nextCursor = null
  svcState.revokedKeys = []
})

afterEach(() => {
  // no-op
})

describe('projectAuthConfigRoutes', () => {
  const app = projectAuthConfigRoutes()

  test('GET /projects/:projectId/auth-config returns service result', async () => {
    svcState.config = {
      mode: 'custom', allowedEmails: ['a@b.com'], allowedDomains: [],
      requireEmailVerification: true,
    }
    const res = await app.request('/projects/proj-x/auth-config')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body as { config: { mode: string } }).config.mode).toBe('custom')
  })

  test('PUT /projects/:projectId/auth-config upserts and returns updated config', async () => {
    const res = await app.request('/projects/proj-y/auth-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'workspace' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body as { config: { mode: string } }).config.mode).toBe('workspace')
  })

  test('PUT with invalid JSON body → 400 bad_request', async () => {
    const res = await app.request('/projects/proj-y/auth-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect((body as { error: { code: string } }).error.code).toBe('bad_request')
  })

  test('PUT with non-object body → 400 bad_request', async () => {
    const res = await app.request('/projects/proj-y/auth-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify('not-an-object'),
    })
    expect(res.status).toBe(400)
  })

  test('PUT with ProjectAuthConfigError → 400 with err.code', async () => {
    svcState.upsertThrows = 'project_auth_error'
    const res = await app.request('/projects/proj-y/auth-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect((body as { error: { code: string } }).error.code).toBe('invalid_mode')
  })

  test('PUT with generic error → 500 internal', async () => {
    svcState.upsertThrows = 'generic'
    const origError = console.error
    console.error = () => {}
    try {
      const res = await app.request('/projects/proj-y/auth-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'custom' }),
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect((body as { error: { code: string } }).error.code).toBe('internal')
    } finally {
      console.error = origError
    }
  })

  test('GET /projects/:projectId/auth-users returns paginated list', async () => {
    svcState.users = [
      { userId: 'u-1', email: 'a@a.com', name: 'A' },
      { userId: 'u-2', email: 'b@b.com', name: 'B' },
    ]
    svcState.nextCursor = 'u-2'
    const res = await app.request('/projects/proj-x/auth-users?cursor=u-0&q=foo&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json() as { items: unknown[]; nextCursor: string }
    expect(body.items).toHaveLength(2)
    expect(body.nextCursor).toBe('u-2')
  })

  test('GET /auth-users with no query params still works', async () => {
    svcState.users = [{ userId: 'u-1', email: 'a@a.com' }]
    const res = await app.request('/projects/proj-x/auth-users')
    expect(res.status).toBe(200)
  })

  test('GET /auth-users with malformed limit ignores it', async () => {
    const res = await app.request('/projects/proj-x/auth-users?limit=not-a-number')
    expect(res.status).toBe(200)
  })

  test('DELETE /projects/:projectId/auth-users/:userId revokes', async () => {
    const res = await app.request('/projects/proj-x/auth-users/u-42', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body as { ok: boolean }).ok).toBe(true)
    expect(svcState.revokedKeys).toContain('proj-x:u-42')
  })
})
