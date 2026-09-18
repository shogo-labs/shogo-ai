// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const store = {
  podIdentity: null as null | { serviceAccountName: string; namespace: string },
  runtimeVerify: null as null | { ok: boolean; reason?: string; projectId?: string; format?: string },
  workspaceVerify: null as null | { ok: boolean; reason?: string; workspaceId?: string },
  resolvedWorkspaceId: null as null | string,

  // prisma.project.findUnique — keyed lookups used by authorizeLifecycleProject
  // (workspaceId), resolveActingUserId (createdBy), and the attach route's
  // best-effort mount (id/name/description of the attached project).
  projects: new Map<string, { workspaceId: string; createdBy?: string | null; id?: string; name?: string; description?: string | null }>(),

  // project-lifecycle.service
  createProjectResult: null as any,
  createProjectThrow: null as null | Error,
  createProjectCalledWith: null as any,
  listGraphResult: [] as any[],
  readConfigResult: null as any,
  readConfigThrow: null as null | Error,
  configureResult: null as any,
  configureThrow: null as null | Error,
  configureCalledWith: null as any,

  // project-attachment.service
  listAttachmentsResult: [] as any[],
  attachResult: null as any,
  attachThrow: null as null | Error,
  attachCalledWith: null as any,
  detachResult: true,
  detachThrow: null as null | Error,

  // workspace-session.service (used by the attach route's best-effort mount)
  getAttachedProjectsResult: [] as any[],

  // agent-proxy-resolver / tunnel-relay / project-runtime-token (agent-call route)
  resolution: null as any,
  relayResponse: null as any,
  fetchResponse: null as any,
  fetchThrow: null as null | Error,
}

function ProjectLifecycleErrorLike(code: string, message = 'nope') {
  const e: any = new Error(message)
  e.name = 'ProjectLifecycleError'
  e.code = code
  return e
}

function ProjectAttachmentErrorLike(code: string, message = 'nope') {
  const e: any = new Error(message)
  e.name = 'ProjectAttachmentError'
  e.code = code
  return e
}

mock.module('../../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => store.podIdentity,
}))

mock.module('../../lib/runtime-token', () => ({
  verifyRuntimeToken: (_t: string, _p?: string) => store.runtimeVerify ?? { ok: false, reason: 'bad' },
}))

mock.module('../../lib/workspace-runtime-token', () => ({
  verifyWorkspaceRuntimeToken: (_t: string) => store.workspaceVerify ?? { ok: false, reason: 'malformed' },
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-runtime-token', () => ({
  resolveProjectWorkspaceId: async (projectId: string) =>
    store.resolvedWorkspaceId ?? store.projects.get(projectId)?.workspaceId ?? null,
  deriveProjectRuntimeToken: async (_projectId: string, _opts?: any) => 'mock-project-runtime-token',
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = store.projects.get(where.id)
        if (!row) return null
        if (select) {
          const out: Record<string, unknown> = {}
          for (const key of Object.keys(select)) out[key] = (row as any)[key] ?? (key === 'id' ? where.id : undefined)
          return out
        }
        return { id: where.id, ...row }
      },
    },
  },
}))

mock.module('../../services/project-lifecycle.service', () => ({
  createProjectInWorkspace: async (input: any) => {
    store.createProjectCalledWith = input
    if (store.createProjectThrow) throw store.createProjectThrow
    return store.createProjectResult
  },
  listWorkspaceProjectsWithAttachments: async (_workspaceId: string) => store.listGraphResult,
  readProjectConfig: async (_projectId: string) => {
    if (store.readConfigThrow) throw store.readConfigThrow
    return store.readConfigResult
  },
  configureProject: async (projectId: string, patch: any) => {
    store.configureCalledWith = { projectId, patch }
    if (store.configureThrow) throw store.configureThrow
    return store.configureResult
  },
}))

mock.module('../../services/project-attachment.service', () => ({
  listAttachments: async (_projectId: string) => store.listAttachmentsResult,
  attachProjectToProject: async (anchorId: string, attachedId: string, mode: string) => {
    store.attachCalledWith = { anchorId, attachedId, mode }
    if (store.attachThrow) throw store.attachThrow
    return store.attachResult
  },
  detachProjectFromProject: async (_anchorId: string, _attachedId: string) => {
    if (store.detachThrow) throw store.detachThrow
    return store.detachResult
  },
  getOrCreatePinnedWorkspaceSession: async (anchorProjectId: string) => ({ id: `pinned-${anchorProjectId}`, workspaceId: 'irrelevant' }),
}))

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  detachProject: async () => true,
  getAttachedProjects: async (_sessionId: string) => store.getAttachedProjectsResult,
}))

mock.module('../../lib/agent-proxy-resolver', () => ({
  resolveAgentProxyPodUrl: async (_projectId: string, _opts?: any) => store.resolution,
}))

mock.module('../../lib/tunnel-relay', () => ({
  relayAgentProxyViaTunnel: async (_opts: any) => store.relayResponse,
}))

// Best-effort mount path in the attach route — default to "not reachable" so
// most tests get a deterministic `mounted: false` without extra setup.
mock.module('../../lib/resolve-workspace-runtime-url', () => ({
  resolveWorkspaceRuntimeUrl: async () => {
    throw new Error('workspace runtime not available in test')
  },
}))
mock.module('../../lib/runtime/manager', () => ({
  getRuntimeManager: () => ({ refreshWorkspaceMergedRoot: async () => {} }),
}))
mock.module('../../lib/metal-warm-pool-controller', () => ({
  getMetalWarmPoolController: () => ({ workspaceMember: async () => ({ ok: true }) }),
}))

const app = (await import('../internal')).default

const SA = { Authorization: 'Bearer sa-token' }
const JSON_H = { 'content-type': 'application/json' }

beforeEach(() => {
  store.podIdentity = { serviceAccountName: 'runtime', namespace: 'shogo' }
  store.runtimeVerify = null
  store.workspaceVerify = null
  store.resolvedWorkspaceId = null
  store.projects = new Map()
  store.createProjectResult = { id: 'proj-new', name: 'New', description: null, workspaceId: 'ws-1', workingMode: 'managed', settings: null }
  store.createProjectThrow = null
  store.createProjectCalledWith = null
  store.listGraphResult = []
  store.readConfigResult = { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null }
  store.readConfigThrow = null
  store.configureResult = { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null }
  store.configureThrow = null
  store.configureCalledWith = null
  store.listAttachmentsResult = []
  store.attachResult = { id: 'att-1', attachedProjectId: 'proj-2', attachedProjectName: 'Target', attachMode: 'readwrite' }
  store.attachThrow = null
  store.attachCalledWith = null
  store.detachResult = true
  store.detachThrow = null
  store.getAttachedProjectsResult = []
  store.resolution = { ok: true, kind: 'cloud', url: 'http://pod.internal:8080' }
  store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })
  store.fetchResponse = null
  store.fetchThrow = null
})

afterEach(() => {
  // Nothing global to restore — every dependency is module-mocked above.
})

// ─── GET /workspaces/:workspaceId/projects/graph ───────────────────────────

describe('GET /workspaces/:workspaceId/projects/graph', () => {
  test('200 for SA', async () => {
    store.listGraphResult = [{ id: 'p1', name: 'P1', attachments: [], agent: null }]
    const res = await app.request('/workspaces/ws-1/projects/graph', { headers: SA })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projects).toHaveLength(1)
  })

  test('200 for a project token whose workspace matches', async () => {
    store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
    store.resolvedWorkspaceId = 'ws-1'
    const res = await app.request('/workspaces/ws-1/projects/graph', { headers: { 'x-runtime-token': 'rt' } })
    expect(res.status).toBe(200)
  })

  test('401 for a project token whose workspace differs (cross-workspace)', async () => {
    store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
    store.resolvedWorkspaceId = 'ws-OTHER'
    const res = await app.request('/workspaces/ws-1/projects/graph', { headers: { 'x-runtime-token': 'rt' } })
    expect(res.status).toBe(401)
  })

  test('200 for a workspace token matching the path workspace', async () => {
    store.workspaceVerify = { ok: true, workspaceId: 'ws-1' }
    const res = await app.request('/workspaces/ws-1/projects/graph', { headers: { 'x-runtime-token': 'wrt' } })
    expect(res.status).toBe(200)
  })

  test('401 for a workspace token scoped to a different workspace', async () => {
    store.workspaceVerify = { ok: true, workspaceId: 'ws-OTHER' }
    const res = await app.request('/workspaces/ws-1/projects/graph', { headers: { 'x-runtime-token': 'wrt' } })
    expect(res.status).toBe(401)
  })

  test('401 with no credentials', async () => {
    const res = await app.request('/workspaces/ws-1/projects/graph')
    expect(res.status).toBe(401)
  })
})

// ─── POST /workspaces/:workspaceId/projects ─────────────────────────────────

describe('POST /workspaces/:workspaceId/projects', () => {
  test('401 with no credentials', async () => {
    const res = await app.request('/workspaces/ws-1/projects', {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(401)
  })

  test('401 for a project token in a different workspace', async () => {
    store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
    store.resolvedWorkspaceId = 'ws-OTHER'
    const res = await app.request('/workspaces/ws-1/projects', {
      method: 'POST',
      headers: { ...JSON_H, 'x-runtime-token': 'rt' },
      body: JSON.stringify({ name: 'X', userId: 'u1' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when name is missing', async () => {
    const res = await app.request('/workspaces/ws-1/projects', { method: 'POST', headers: SA, body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })

  test('400 when no userId can be resolved (SA caller, no explicit userId)', async () => {
    const res = await app.request('/workspaces/ws-1/projects', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(400)
  })

  test('201 for SA with explicit userId', async () => {
    const res = await app.request('/workspaces/ws-1/projects', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ name: 'X', userId: 'u1', techStackId: 'react-app' }),
    })
    expect(res.status).toBe(201)
    expect(store.createProjectCalledWith).toMatchObject({ workspaceId: 'ws-1', actingUserId: 'u1', name: 'X', techStackId: 'react-app' })
    const body = await res.json()
    expect(body.project.id).toBe('proj-new')
  })

  test('201 for a project token falling back to the calling project createdBy', async () => {
    store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
    store.resolvedWorkspaceId = 'ws-1'
    store.projects.set('proj-1', { workspaceId: 'ws-1', createdBy: 'creator-1' })
    const res = await app.request('/workspaces/ws-1/projects', {
      method: 'POST',
      headers: { ...JSON_H, 'x-runtime-token': 'rt' },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(201)
    expect(store.createProjectCalledWith).toMatchObject({ actingUserId: 'creator-1' })
  })

  test('402 when the lifecycle service rejects with instance_too_small', async () => {
    store.createProjectThrow = ProjectLifecycleErrorLike('instance_too_small')
    const res = await app.request('/workspaces/ws-1/projects', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ name: 'X', userId: 'u1' }),
    })
    expect(res.status).toBe(402)
  })
})

// ─── GET / POST / DELETE /projects/:projectId/attachments ─────────────────

describe('attachments routes — auth matrix (shared authorizeLifecycleProject)', () => {
  test('401 with no credentials', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/anchor-1/attachments')
    expect(res.status).toBe(401)
  })

  test('401 when the project does not exist', async () => {
    const res = await app.request('/projects/does-not-exist/attachments', { headers: SA })
    expect(res.status).toBe(401)
  })

  test('401 for a project token whose workspace differs from the target project', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
    store.resolvedWorkspaceId = 'ws-OTHER'
    const res = await app.request('/projects/anchor-1/attachments', { headers: { 'x-runtime-token': 'rt' } })
    expect(res.status).toBe(401)
  })

  test('200 for a project token in the same workspace as the target project', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.runtimeVerify = { ok: true, projectId: 'proj-1', format: 'v1' }
    store.resolvedWorkspaceId = 'ws-1'
    const res = await app.request('/projects/anchor-1/attachments', { headers: { 'x-runtime-token': 'rt' } })
    expect(res.status).toBe(200)
  })

  test('200 for a workspace token matching the target project workspace', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.workspaceVerify = { ok: true, workspaceId: 'ws-1' }
    const res = await app.request('/projects/anchor-1/attachments', { headers: { 'x-runtime-token': 'wrt' } })
    expect(res.status).toBe(200)
  })

  test('401 for a workspace token scoped to a different workspace', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.workspaceVerify = { ok: true, workspaceId: 'ws-OTHER' }
    const res = await app.request('/projects/anchor-1/attachments', { headers: { 'x-runtime-token': 'wrt' } })
    expect(res.status).toBe(401)
  })

  test('200 for SA regardless of workspace', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/anchor-1/attachments', { headers: SA })
    expect(res.status).toBe(200)
  })
})

describe('GET /projects/:projectId/attachments', () => {
  test('200 returns the attachment list', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.listAttachmentsResult = [{ id: 'a1', attachedProjectId: 'p2', attachedProjectName: 'P2', attachMode: 'readwrite' }]
    const res = await app.request('/projects/anchor-1/attachments', { headers: SA })
    const body = await res.json()
    expect(body.attachments).toHaveLength(1)
  })
})

describe('POST /projects/:projectId/attachments', () => {
  test('400 when attachedProjectId is missing', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/anchor-1/attachments', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('201 with mounted:false when the live-mount attempt fails (default mock)', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.projects.set('p2', { workspaceId: 'ws-1', id: 'p2', name: 'P2', description: null })
    const res = await app.request('/projects/anchor-1/attachments', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ attachedProjectId: 'p2', attachMode: 'readonly' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mounted).toBe(false)
    expect(store.attachCalledWith).toEqual({ anchorId: 'anchor-1', attachedId: 'p2', mode: 'readonly' })
  })

  test('201 with mounted:true when the live-mount path resolves', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.projects.set('p2', { workspaceId: 'ws-1', id: 'p2', name: 'P2', description: 'desc' })
    // Swap in a resolving mock just for this test via a fresh mock.module call.
    mock.module('../../lib/resolve-workspace-runtime-url', () => ({
      resolveWorkspaceRuntimeUrl: async () => ({ mode: 'metal', url: 'http://metal.internal' }),
    }))
    const res = await app.request('/projects/anchor-1/attachments', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ attachedProjectId: 'p2' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.mounted).toBe(true)
    // Restore the default (throwing) mock so later tests keep their assumption.
    mock.module('../../lib/resolve-workspace-runtime-url', () => ({
      resolveWorkspaceRuntimeUrl: async () => {
        throw new Error('workspace runtime not available in test')
      },
    }))
  })

  test('409 when the attachment service rejects (e.g. cross_workspace)', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.attachThrow = ProjectAttachmentErrorLike('cross_workspace')
    const res = await app.request('/projects/anchor-1/attachments', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ attachedProjectId: 'p2' }),
    })
    expect(res.status).toBe(409)
  })

  test('400 when the attachment service rejects with self_attach', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.attachThrow = ProjectAttachmentErrorLike('self_attach')
    const res = await app.request('/projects/anchor-1/attachments', {
      method: 'POST',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ attachedProjectId: 'anchor-1' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /projects/:projectId/attachments/:attachedProjectId', () => {
  test('200 with removed flag', async () => {
    store.projects.set('anchor-1', { workspaceId: 'ws-1' })
    store.detachResult = true
    const res = await app.request('/projects/anchor-1/attachments/p2', { method: 'DELETE', headers: SA })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.removed).toBe(true)
  })
})

// ─── GET / PATCH /projects/:projectId/config ────────────────────────────────

describe('GET /projects/:projectId/config', () => {
  test('200 returns the config snapshot', async () => {
    store.projects.set('proj-1', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/proj-1/config', { headers: SA })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.project.id).toBe('proj-1')
  })

  test('404 when the underlying project is missing', async () => {
    store.projects.set('proj-1', { workspaceId: 'ws-1' })
    store.readConfigThrow = ProjectLifecycleErrorLike('not_found')
    const res = await app.request('/projects/proj-1/config', { headers: SA })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /projects/:projectId/config', () => {
  test('200 forwards agent + settings patch to configureProject', async () => {
    store.projects.set('proj-1', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/proj-1/config', {
      method: 'PATCH',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ name: 'Renamed', agent: { heartbeatEnabled: true, heartbeatInterval: 900 } }),
    })
    expect(res.status).toBe(200)
    expect(store.configureCalledWith).toMatchObject({
      projectId: 'proj-1',
      patch: { name: 'Renamed', agent: { heartbeatEnabled: true, heartbeatInterval: 900 } },
    })
  })

  test('402 when configureProject rejects with paywall', async () => {
    store.projects.set('proj-1', { workspaceId: 'ws-1' })
    store.configureThrow = ProjectLifecycleErrorLike('paywall')
    const res = await app.request('/projects/proj-1/config', {
      method: 'PATCH',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ agent: { heartbeatEnabled: true } }),
    })
    expect(res.status).toBe(402)
  })

  test('402 when configureProject rejects with instance_too_small', async () => {
    store.projects.set('proj-1', { workspaceId: 'ws-1' })
    store.configureThrow = ProjectLifecycleErrorLike('instance_too_small')
    const res = await app.request('/projects/proj-1/config', {
      method: 'PATCH',
      headers: { ...SA, ...JSON_H },
      body: JSON.stringify({ settings: { techStackId: 'docker-compose' } }),
    })
    expect(res.status).toBe(402)
  })
})

// ─── POST /projects/:projectId/agent-call ───────────────────────────────────

describe('POST /projects/:projectId/agent-call', () => {
  test('401 with no credentials', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/proj-2/agent-call', {
      method: 'POST', headers: JSON_H, body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when message is missing', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    const res = await app.request('/projects/proj-2/agent-call', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('propagates the resolver failure status/body when resolution fails', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    store.resolution = { ok: false, status: 503, body: { error: { code: 'instance_offline', message: 'offline' } } }
    const res = await app.request('/projects/proj-2/agent-call', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('instance_offline')
  })

  test('tunnel branch: forwards through relayAgentProxyViaTunnel', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    store.resolution = { ok: true, kind: 'tunnel', instanceId: 'inst-1', workspaceId: 'ws-1' }
    store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'from tunnel' }), { status: 200 })
    const res = await app.request('/projects/proj-2/agent-call', {
      method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ message: 'hi', runId: 'run-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reply).toBe('from tunnel')
  })

  test('cloud branch: forwards to the resolved pod URL and passes through the response', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    store.resolution = { ok: true, kind: 'cloud', url: 'http://pod.internal:8080' }
    const originalFetch = globalThis.fetch
    let capturedUrl = ''
    let capturedBody = ''
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url)
      capturedBody = init?.body ?? ''
      return new Response(JSON.stringify({ status: 'completed', reply: 'from pod', runId: 'run-2' }), { status: 200 })
    }) as any
    try {
      const res = await app.request('/projects/proj-2/agent-call', {
        method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ message: 'hi', runId: 'run-2' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reply).toBe('from pod')
      expect(capturedUrl).toBe('http://pod.internal:8080/agent/pipeline/call')
      expect(JSON.parse(capturedBody).runId).toBe('run-2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('cloud branch: 504 with agent_call_timeout when the fetch aborts', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    store.resolution = { ok: true, kind: 'cloud', url: 'http://pod.internal:8080' }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      const err: any = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    }) as any
    try {
      const res = await app.request('/projects/proj-2/agent-call', {
        method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ message: 'hi' }),
      })
      expect(res.status).toBe(504)
      const body = await res.json()
      expect(body.error.code).toBe('agent_call_timeout')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('cloud branch: 202 accepted when wait=false', async () => {
    store.projects.set('proj-2', { workspaceId: 'ws-1' })
    store.resolution = { ok: true, kind: 'cloud', url: 'http://pod.internal:8080' }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'accepted', runId: 'run-3', sessionId: 'run:run-3' }), { status: 202 })) as any
    try {
      const res = await app.request('/projects/proj-2/agent-call', {
        method: 'POST', headers: { ...SA, ...JSON_H }, body: JSON.stringify({ message: 'hi', runId: 'run-3', wait: false }),
      })
      expect(res.status).toBe(202)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
