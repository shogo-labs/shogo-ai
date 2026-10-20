// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET`/`PATCH /api/internal/workspaces/:workspaceId/config` — the workspace
 * agent's own config. It must be workspace-scoped: a workspace chat's
 * capability toggles belong to the workspace, never to the anchor project the
 * runtime happens to be pinned to.
 *
 * Prisma is faked with an in-memory row so the real service (and its patch
 * merge) is exercised; only the auth/token plumbing is mocked.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

const store = {
  podIdentity: null as null | { serviceAccountName: string; namespace: string },
  runtimeVerify: null as null | { ok: boolean; reason?: string; projectId?: string; format?: string },
  workspaceVerify: null as null | { ok: boolean; reason?: string; workspaceId?: string },
  resolvedWorkspaceId: null as null | string,
  workspaces: new Map<string, { id: string; name: string; kind: string; settings: unknown }>(),
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}

mock.module('../../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => store.podIdentity,
}))

mock.module('../../lib/runtime-token', () => ({
  getSigningSecret: () => 'test-runtime-secret',
  verifyRuntimeToken: (_t: string, _p?: string) => store.runtimeVerify ?? { ok: false, reason: 'bad' },
  deriveRuntimeToken: (projectId: string) => `rt_v1_${projectId}_mock`,
}))

mock.module('../../lib/workspace-runtime-token', () => ({
  verifyWorkspaceRuntimeToken: (_t: string) => store.workspaceVerify ?? { ok: false, reason: 'malformed' },
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-runtime-token', () => ({
  resolveProjectWorkspaceId: async (projectId: string) =>
    store.resolvedWorkspaceId ?? (store.workspaces.has(projectId) ? projectId : null),
  deriveProjectRuntimeToken: async (_projectId: string, _opts?: any) => 'mock-project-runtime-token',
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = store.workspaces.get(where.id)
        if (!row) return null
        if (!select) return { ...row }
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(select)) out[key] = (row as any)[key]
        return out
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.workspaces.get(where.id)
        if (!row) throw new Error('not found')
        store.updates.push({ id: where.id, data })
        Object.assign(row, data)
        return { ...row }
      },
    },
  },
}))

const app = (await import('../internal')).default
const { _setRbacModeForTests } = await import('../../lib/authz')
const { parseWorkspaceSettings } = await import('../../lib/workspace-settings')

const SA = { Authorization: 'Bearer sa-token' }
const JSON_H = { 'content-type': 'application/json' }

beforeEach(() => {
  _setRbacModeForTests('shadow')
  store.podIdentity = { serviceAccountName: 'runtime', namespace: 'shogo' }
  store.runtimeVerify = null
  store.workspaceVerify = null
  store.resolvedWorkspaceId = null
  store.updates = []
  store.workspaces = new Map([
    ['ws-1', { id: 'ws-1', name: 'Odin', kind: 'team', settings: { theme: 'dark', boardAdminEnabled: true } }],
  ])
})

afterEach(() => {
  _setRbacModeForTests(null)
})

describe('GET /workspaces/:workspaceId/config', () => {
  test('200 for SA with the workspace settings parsed to an object', async () => {
    store.workspaces.set('ws-1', {
      id: 'ws-1',
      name: 'Odin',
      kind: 'team',
      // A row written before the write-path fix: a jsonb string scalar.
      settings: JSON.stringify({ boardAdminEnabled: false }),
    })
    const res = await app.request('/workspaces/ws-1/config', { headers: SA })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspace.id).toBe('ws-1')
    expect(body.workspace.kind).toBe('team')
    expect(body.workspace.settings).toEqual({ boardAdminEnabled: false })
  })

  test('200 for a workspace token naming the same workspace', async () => {
    store.podIdentity = null
    store.workspaceVerify = { ok: true, workspaceId: 'ws-1' }
    const res = await app.request('/workspaces/ws-1/config', { headers: { 'x-runtime-token': 'wrt' } })
    expect(res.status).toBe(200)
  })

  test('401 without a token', async () => {
    store.podIdentity = null
    const res = await app.request('/workspaces/ws-1/config')
    expect(res.status).toBe(401)
  })

  test("401 for a token scoped to a different workspace", async () => {
    store.podIdentity = null
    store.workspaceVerify = { ok: true, workspaceId: 'ws-OTHER' }
    const res = await app.request('/workspaces/ws-1/config', { headers: { 'x-runtime-token': 'wrt' } })
    expect(res.status).toBe(401)
  })

  test('404 for a workspace that does not exist', async () => {
    const res = await app.request('/workspaces/ws-missing/config', { headers: SA })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })
})

describe('PATCH /workspaces/:workspaceId/config', () => {
  test('merges the patch and keeps settings the patch does not mention', async () => {
    const res = await app.request('/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: { ...JSON_H, ...SA },
      body: JSON.stringify({ settings: { boardAdminEnabled: false } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspace.settings).toEqual({ theme: 'dark', boardAdminEnabled: false })
    const stored = parseWorkspaceSettings(store.workspaces.get('ws-1')!.settings)
    expect(stored).toEqual({ theme: 'dark', boardAdminEnabled: false })
  })

  test('only the addressed workspace is written', async () => {
    store.workspaces.set('ws-2', { id: 'ws-2', name: 'Other', kind: 'team', settings: { theme: 'light' } })
    await app.request('/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: { ...JSON_H, ...SA },
      body: JSON.stringify({ settings: { shellEnabled: false } }),
    })
    expect(store.updates.map((u) => u.id)).toEqual(['ws-1'])
    expect(parseWorkspaceSettings(store.workspaces.get('ws-2')!.settings)).toEqual({ theme: 'light' })
  })

  test('400 when settings is not an object', async () => {
    const res = await app.request('/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: { ...JSON_H, ...SA },
      body: JSON.stringify({ settings: 'nope' }),
    })
    expect(res.status).toBe(400)
    expect(store.updates).toHaveLength(0)
  })

  test('403 requester_required for an unclaimed runtime token once RBAC is on', async () => {
    store.podIdentity = null
    store.workspaceVerify = { ok: true, workspaceId: 'ws-1' }
    _setRbacModeForTests('on')
    const res = await app.request('/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: { ...JSON_H, 'x-runtime-token': 'wrt' },
      body: JSON.stringify({ settings: { shellEnabled: false } }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('requester_required')
    expect(store.updates).toHaveLength(0)
  })
})
