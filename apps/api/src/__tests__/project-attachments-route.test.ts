// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Folders-panel attachments: one authz policy for cloud, desktop and the
 * internal runtime API (SHO-207).
 *
 * Before this, the cloud panel called `/api/local/projects/:id/attachments`,
 * which is only mounted when `SHOGO_LOCAL_MODE=true` (so 404 on staging), and
 * the local handlers only checked that *someone* was signed in — any user could
 * attach any project. The rules now live in
 * `services/project-attachment.authz.ts`:
 *
 *   GET            → project:read  on the anchor
 *   POST / DELETE  → project:update on the anchor
 *   POST target    → project:read (readonly) / project:update (readwrite)
 *   GET listing    → only targets the caller can read
 *   any action     → anchor and target share a workspace
 *
 * The RBAC engine is stubbed with a tiny grant table (it has its own suite);
 * everything above it — the policy, the handlers and the status codes — is real.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

type Grant = { workspaceId: string; permissions: string[] }

/** projectId → what the signed-in caller may do on it. Absent = cannot see it. */
let grants: Record<string, Grant> = {}
/** Attached-project ids the caller can read (drives `accessibleProjectsWhere`). */
let readableTargets: Set<string> | null = null

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      project: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          grants[where.id] ? { id: where.id, workspaceId: grants[where.id].workspaceId } : null,
        findMany: async ({ where }: { where: any }) => {
          const ids: string[] = where?.AND?.[0]?.id?.in ?? []
          return ids.filter((id) => readableTargets === null || readableTargets.has(id)).map((id) => ({ id }))
        },
      },
    },
  }),
)

const realAuthz = await import('../lib/authz')
mock.module('../lib/authz', () => ({
  ...realAuthz,
  principalOf: () => ({ userId: 'user-1', via: 'session' }),
  authorize: async (_c: unknown, permission: string, scope: { projectId: string }) => {
    const grant = grants[scope.projectId]
    // Cannot see the project at all → 404, exactly like a missing one.
    if (!grant || !grant.permissions.includes('project:read')) {
      return { ok: false, status: 404, code: 'not_found', message: 'Project not found' }
    }
    if (!grant.permissions.includes(permission)) {
      return { ok: false, status: 403, code: 'forbidden', message: `Missing permission: ${permission}` }
    }
    return { ok: true, access: { workspaceId: grant.workspaceId, projectId: scope.projectId } }
  },
  accessibleProjectsWhere: async () =>
    readableTargets === null ? null : { id: { in: [...readableTargets] } },
}))

const calls = { attach: [] as unknown[], detach: [] as unknown[] }

class ProjectAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProjectAttachmentError'
  }
}

let attachmentRows: Array<{
  id: string
  attachedProjectId: string
  attachedProjectName: string | null
  attachMode: string
}> = []

mock.module('../services/project-attachment.service', () => ({
  ProjectAttachmentError,
  listAttachments: async () => attachmentRows,
  // `local-projects.ts` imports these too, and bun's `mock.module` is
  // process-global — this factory must satisfy every consumer, not just the
  // routes under test, or a combined run fails to link.
  getOrCreatePinnedWorkspaceSession: async () => ({ id: 's-1', workspaceId: 'ws-1' }),
  createProjectWorkspaceSession: async () => ({ id: 's-1', workspaceId: 'ws-1' }),
  attachProjectToProject: async (anchor: string, attached: string, mode: string) => {
    calls.attach.push({ anchor, attached, mode })
    const anchorGrant = grants[anchor]
    const targetGrant = grants[attached]
    // Mirrors the service's authoritative same-workspace rule.
    if (anchorGrant && targetGrant && anchorGrant.workspaceId !== targetGrant.workspaceId) {
      throw new ProjectAttachmentError('cross_workspace', `${attached} is not in the same workspace`)
    }
    return { id: 'att-1', attachedProjectId: attached, attachedProjectName: 'B', attachMode: mode }
  },
  detachProjectFromProject: async (anchor: string, attached: string) => {
    calls.detach.push({ anchor, attached })
    return true
  },
}))

const {
  attachProjectHandler,
  detachProjectHandler,
  listProjectAttachmentsHandler,
} = await import('../routes/project-attachments')

function app() {
  const a = new Hono()
  a.use('*', async (c, next) => {
    c.set('auth' as never, { userId: 'user-1', via: 'session' } as never)
    await next()
  })
  // Same paths the real routers use, so the tests exercise :id / :attachedProjectId.
  a.get('/:id/attachments', listProjectAttachmentsHandler)
  a.post('/:id/attachments', attachProjectHandler)
  a.delete('/:id/attachments/:attachedProjectId', detachProjectHandler)
  return a
}

const attach = (anchor: string, body: unknown) =>
  app().request(`/${anchor}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe.each([
  ['cloud mode', undefined],
  ['local mode', 'true'],
])('project attachments authz (%s)', (_label, localMode) => {
  const saved = process.env.SHOGO_LOCAL_MODE

  beforeEach(() => {
    calls.attach.length = 0
    calls.detach.length = 0
    attachmentRows = []
    readableTargets = null
    if (localMode === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = localMode

    grants = {
      A: { workspaceId: 'ws-1', permissions: ['project:read', 'project:update'] },
      B: { workspaceId: 'ws-1', permissions: ['project:read', 'project:update'] },
      C: { workspaceId: 'ws-1', permissions: ['project:read'] },
      otherWs: { workspaceId: 'ws-2', permissions: ['project:read', 'project:update'] },
    }
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = saved
  })

  test('owner can attach, list and detach', async () => {
    const attached = await attach('A', { attachedProjectId: 'B' })
    expect(attached.status).toBe(201)
    expect(calls.attach).toEqual([{ anchor: 'A', attached: 'B', mode: 'readwrite' }])

    attachmentRows = [
      { id: 'att-1', attachedProjectId: 'B', attachedProjectName: 'B', attachMode: 'readwrite' },
    ]
    const listed = await app().request('/A/attachments')
    expect(listed.status).toBe(200)
    expect((await listed.json()).attachments).toHaveLength(1)

    const detached = await app().request('/A/attachments/B', { method: 'DELETE' })
    expect(detached.status).toBe(200)
    expect(await detached.json()).toEqual({ ok: true, removed: true })
    expect(calls.detach).toEqual([{ anchor: 'A', attached: 'B' }])
  })

  test('a user who cannot see the anchor gets 404, not 403', async () => {
    // `notMine` has no grant at all — the caller is a member of another workspace.
    const res = await attach('notMine', { attachedProjectId: 'B' })
    expect(res.status).toBe(404)
    expect(calls.attach).toHaveLength(0)
  })

  test('an unreadable target is a 404, never a cross-workspace 409', async () => {
    const res = await attach('A', { attachedProjectId: 'notMine' })
    expect(res.status).toBe(404)
    expect(calls.attach).toHaveLength(0)
  })

  test('a target in another workspace is refused before anything is written', async () => {
    const res = await attach('A', { attachedProjectId: 'otherWs' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'cross_workspace' })
    expect(calls.attach).toHaveLength(0)
  })

  test('a readonly attach only needs project:read on the target', async () => {
    const res = await attach('A', { attachedProjectId: 'C', attachMode: 'readonly' })
    expect(res.status).toBe(201)
    expect(calls.attach).toEqual([{ anchor: 'A', attached: 'C', mode: 'readonly' }])
  })

  test('a readwrite attach needs project:update on the target', async () => {
    const res = await attach('A', { attachedProjectId: 'C', attachMode: 'readwrite' })
    expect(res.status).toBe(403)
    expect(calls.attach).toHaveLength(0)
  })

  test('detach needs project:update on the anchor', async () => {
    const res = await app().request('/C/attachments/B', { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(calls.detach).toHaveLength(0)
  })

  test('listing hides targets the caller cannot read', async () => {
    attachmentRows = [
      { id: 'att-1', attachedProjectId: 'B', attachedProjectName: 'B', attachMode: 'readwrite' },
      { id: 'att-2', attachedProjectId: 'otherWs', attachedProjectName: 'X', attachMode: 'readonly' },
    ]
    readableTargets = new Set(['B'])
    const res = await app().request('/A/attachments')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.attachments.map((a: { attachedProjectId: string }) => a.attachedProjectId)).toEqual(['B'])
  })

  test('missing attachedProjectId is a 400, not a 500', async () => {
    const res = await attach('A', {})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'attachedProjectId_required' })
  })
})
