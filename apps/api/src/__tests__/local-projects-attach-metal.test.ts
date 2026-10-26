// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Folders panel attach / detach: off metal a change restarts the anchor
 * runtime so the new member is mounted; on metal the attachment is a durable
 * record only and the anchor runtime is left alone.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

mock.module('../lib/prisma', () => withPrismaExports({ prisma: {} }))

// This spec covers mount/restart behaviour, not the authz policy (which has its
// own suite in project-attachments-route.test.ts). Keep every real export (many
// modules import this one) and allow all permissions so the real
// `authorizeAttachmentAction` still runs with a stubbed RBAC engine.
const realAuthz = await import('../lib/authz')
mock.module('../lib/authz', () => ({
  ...realAuthz,
  authorize: async (_c: unknown, _permission: string, scope: { projectId: string }) => ({
    ok: true,
    access: { workspaceId: 'ws-1', projectId: scope.projectId },
  }),
  accessibleProjectsWhere: async () => null,
}))

const calls = { attach: [] as unknown[], detach: [] as unknown[], stop: [] as string[], spawnOpts: [] as string[] }

class ProjectAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProjectAttachmentError'
  }
}

mock.module('../services/project-attachment.service', () => ({
  ProjectAttachmentError,
  attachProjectToProject: async (anchor: string, attached: string, mode: string) => {
    calls.attach.push({ anchor, attached, mode })
    return { id: 'att-1', attachedProjectId: attached, attachMode: mode }
  },
  detachProjectFromProject: async (anchor: string, attached: string) => {
    calls.detach.push({ anchor, attached })
    return true
  },
  createProjectWorkspaceSession: async () => ({ id: 's-1' }),
  getOrCreatePinnedWorkspaceSession: async () => ({ id: 's-1' }),
  listAttachments: async () => [],
}))

mock.module('../lib/runtime/manager', () => ({
  projectWorkspaceRuntimeKey: (id: string) => `ws:proj:${id}`,
  getRuntimeManager: () => ({
    resolveAnchorSpawnOpts: async (id: string) => {
      calls.spawnOpts.push(id)
      return null
    },
    stop: async (key: string) => {
      calls.stop.push(key)
    },
  }),
}))

const { localProjectsRoutes } = await import('../routes/local-projects')

function app() {
  const a = new Hono()
  a.use('*', async (c, next) => {
    c.set('auth' as never, { userId: 'user-1' } as never)
    await next()
  })
  a.route('/', localProjectsRoutes())
  return a
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('local-projects attachments vs the anchor runtime', () => {
  const saved = { metal: process.env.SHOGO_METAL_ENABLED, local: process.env.SHOGO_LOCAL_MODE }

  beforeEach(() => {
    calls.attach.length = 0
    calls.detach.length = 0
    calls.stop.length = 0
    calls.spawnOpts.length = 0
    delete process.env.SHOGO_LOCAL_MODE
  })
  afterEach(() => {
    if (saved.metal === undefined) delete process.env.SHOGO_METAL_ENABLED
    else process.env.SHOGO_METAL_ENABLED = saved.metal
    if (saved.local === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = saved.local
  })

  test('off metal, attach restarts the anchor runtime', async () => {
    delete process.env.SHOGO_METAL_ENABLED
    const res = await app().request('/anchor-1/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachedProjectId: 'p2' }),
    })
    expect(res.status).toBe(201)
    await settle()
    expect(calls.spawnOpts).toEqual(['anchor-1'])
  })

  test('on metal, attach and detach record the edge without touching the anchor runtime', async () => {
    process.env.SHOGO_METAL_ENABLED = 'true'
    const attached = await app().request('/anchor-1/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachedProjectId: 'p2', attachMode: 'readonly' }),
    })
    expect(attached.status).toBe(201)
    expect((await attached.json()).attachment.attachedProjectId).toBe('p2')

    const detached = await app().request('/anchor-1/attachments/p2', { method: 'DELETE' })
    expect(detached.status).toBe(200)
    expect((await detached.json()).removed).toBe(true)

    await settle()
    expect(calls.attach).toEqual([{ anchor: 'anchor-1', attached: 'p2', mode: 'readonly' }])
    expect(calls.detach).toEqual([{ anchor: 'anchor-1', attached: 'p2' }])
    expect(calls.spawnOpts).toEqual([])
    expect(calls.stop).toEqual([])
  })
})
