// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface State {
  // project.findMany returns rows whose ids are in this set (filtered by the where.id.in)
  projectsInWorkspace: Set<string>
  // chatSession.findUnique result for getSessionWorkspaceId
  sessionRow: { contextType?: string; workspaceId?: string | null } | null
  primarySession: any
  primaryCreateErrorCode: string | null
  createCalls: any[]
  upsertCalls: any[]
  deleteManyCount: number
  findManyAttached: any[]
}

const s: State = {
  projectsInWorkspace: new Set(),
  sessionRow: null,
  primarySession: null,
  primaryCreateErrorCode: null,
  createCalls: [],
  upsertCalls: [],
  deleteManyCount: 0,
  findManyAttached: [],
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: {
      create: async (args: any) => {
        s.createCalls.push(args)
        if (s.primaryCreateErrorCode) {
          s.primarySession = {
            id: 'sess-primary-raced',
            workspaceId: args.data.workspaceId,
            contextType: 'workspace',
            isPrimary: true,
            attachedProjects: [],
          }
          const error = Object.assign(new Error('unique constraint'), { code: s.primaryCreateErrorCode })
          throw error
        }
        const attached = args.data.attachedProjects?.create ?? []
        return {
          id: 'sess-1',
          ...args.data,
          attachedProjects: attached.map((a: any, i: number) => ({
            id: `csp-${i}`,
            projectId: a.projectId,
            attachMode: a.attachMode,
          })),
        }
      },
      findUnique: async (_args: any) => s.sessionRow,
      findFirst: async (_args: any) => s.primarySession,
    },
    chatSessionProject: {
      upsert: async (args: any) => {
        s.upsertCalls.push(args)
        return {
          id: 'csp-x',
          projectId: args.create.projectId,
          attachMode: args.create.attachMode,
        }
      },
      deleteMany: async (_args: any) => ({ count: s.deleteManyCount }),
      findMany: async (_args: any) => s.findManyAttached,
    },
    project: {
      findMany: async (args: any) => {
        const ids: string[] = args.where.id.in
        return ids.filter((id) => s.projectsInWorkspace.has(id)).map((id) => ({ id }))
      },
    },
  },
}))

const svc = await import('../workspace-session.service')

beforeEach(() => {
  s.projectsInWorkspace = new Set()
  s.sessionRow = null
  s.primarySession = null
  s.primaryCreateErrorCode = null
  s.createCalls = []
  s.upsertCalls = []
  s.deleteManyCount = 0
  s.findManyAttached = []
})

describe('createWorkspaceSession', () => {
  it('creates a workspace-scoped session with no attachments', async () => {
    const res = await svc.createWorkspaceSession('ws-1', { name: 'My chat' })
    expect(res.workspaceId).toBe('ws-1')
    expect(res.attached).toEqual([])
    expect(s.createCalls[0].data.contextType).toBe('workspace')
    expect(s.createCalls[0].data.workspaceId).toBe('ws-1')
    expect(s.createCalls[0].data.inferredName).toBe('My chat')
  })

  it('attaches valid projects on create', async () => {
    s.projectsInWorkspace = new Set(['p1', 'p2'])
    const res = await svc.createWorkspaceSession('ws-1', { attachProjectIds: ['p1', 'p2'] })
    expect(res.attached.map((a) => a.projectId).sort()).toEqual(['p1', 'p2'])
    expect(res.attached.every((a) => a.attachMode === 'readwrite')).toBe(true)
  })

  it('rejects attaching a project from another workspace', async () => {
    s.projectsInWorkspace = new Set(['p1'])
    await expect(
      svc.createWorkspaceSession('ws-1', { attachProjectIds: ['p1', 'p-other'] }),
    ).rejects.toMatchObject({ code: 'project_not_in_workspace' })
  })

  it('dedupes attach ids', async () => {
    s.projectsInWorkspace = new Set(['p1'])
    const res = await svc.createWorkspaceSession('ws-1', { attachProjectIds: ['p1', 'p1'] })
    expect(res.attached).toHaveLength(1)
  })
})

describe('getOrCreatePrimaryWorkspaceSession', () => {
  it('creates the stable primary chat when one does not exist', async () => {
    const session = await svc.getOrCreatePrimaryWorkspaceSession('ws-personal')
    expect(session.isPrimary).toBe(true)
    expect(s.createCalls[0].data).toMatchObject({
      workspaceId: 'ws-personal',
      contextType: 'workspace',
      name: 'Chat',
      isPrimary: true,
    })
  })

  it('reuses the existing primary chat', async () => {
    s.primarySession = { id: 'sess-primary', isPrimary: true }
    const session = await svc.getOrCreatePrimaryWorkspaceSession('ws-personal')
    expect(session.id).toBe('sess-primary')
    expect(s.createCalls).toHaveLength(0)
  })

  it('returns the primary created by another API pod after a unique-index race', async () => {
    s.primaryCreateErrorCode = 'P2002'
    const session = await svc.getOrCreatePrimaryWorkspaceSession('ws-raced')
    expect(session.id).toBe('sess-primary-raced')
    expect(s.createCalls).toHaveLength(1)
  })
})

describe('attachProject', () => {
  it('attaches a project to a workspace session', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1' }
    s.projectsInWorkspace = new Set(['p1'])
    const res = await svc.attachProject('sess-1', 'p1', 'readonly')
    expect(res.projectId).toBe('p1')
    expect(res.attachMode).toBe('readonly')
    expect(s.upsertCalls).toHaveLength(1)
  })

  it('throws session_not_found for an unknown session', async () => {
    s.sessionRow = null
    await expect(svc.attachProject('nope', 'p1')).rejects.toMatchObject({ code: 'session_not_found' })
  })

  it('throws not_workspace_session for a project-scoped session', async () => {
    s.sessionRow = { contextType: 'project', workspaceId: null }
    await expect(svc.attachProject('sess-1', 'p1')).rejects.toMatchObject({
      code: 'not_workspace_session',
    })
  })

  it('rejects a project from another workspace', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1' }
    s.projectsInWorkspace = new Set()
    await expect(svc.attachProject('sess-1', 'p-other')).rejects.toMatchObject({
      code: 'project_not_in_workspace',
    })
  })
})

describe('detachProject', () => {
  it('returns true when a row was removed', async () => {
    s.deleteManyCount = 1
    expect(await svc.detachProject('sess-1', 'p1')).toBe(true)
  })
  it('returns false when nothing was attached', async () => {
    s.deleteManyCount = 0
    expect(await svc.detachProject('sess-1', 'p1')).toBe(false)
  })
})

describe('getAttachedProjects', () => {
  it('maps rows to AttachedProject', async () => {
    s.findManyAttached = [
      { id: 'a', projectId: 'p1', attachMode: 'readwrite' },
      { id: 'b', projectId: 'p2', attachMode: 'readonly' },
    ]
    const res = await svc.getAttachedProjects('sess-1')
    expect(res).toEqual([
      { id: 'a', projectId: 'p1', attachMode: 'readwrite' },
      { id: 'b', projectId: 'p2', attachMode: 'readonly' },
    ])
  })
})
