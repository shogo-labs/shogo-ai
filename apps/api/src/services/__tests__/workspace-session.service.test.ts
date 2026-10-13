// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface State {
  // project.findMany returns rows whose ids are in this set (filtered by the where.id.in)
  projectsInWorkspace: Set<string>
  // chatSession.findUnique result for getSessionWorkspaceId
  sessionRow: { contextType?: string; workspaceId?: string | null; contextId?: string | null; isPrimary?: boolean } | null
  updateManyCalls: any[]
  primarySession: any
  listedSessions: any[]
  findManySessionCalls: any[]
  createCalls: any[]
  upsertCalls: any[]
  deleteManyCount: number
  findManyAttached: any[]
  // project.findUnique result: the workspace that owns the looked-up project
  projectWorkspaceId: string | null
}

const s: State = {
  projectsInWorkspace: new Set(),
  sessionRow: null,
  updateManyCalls: [],
  primarySession: null,
  listedSessions: [],
  findManySessionCalls: [],
  createCalls: [],
  upsertCalls: [],
  deleteManyCount: 0,
  findManyAttached: [],
  projectWorkspaceId: null,
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: {
      create: async (args: any) => {
        s.createCalls.push(args)
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
      findMany: async (args: any) => {
        s.findManySessionCalls.push(args)
        return s.listedSessions
      },
      updateMany: async (args: any) => {
        s.updateManyCalls.push(args)
        const row = s.sessionRow
        if (!row || (args.where.contextId === null && row.contextId)) return { count: 0 }
        Object.assign(row, args.data)
        return { count: 1 }
      },
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
      findUnique: async (_args: any) =>
        s.projectWorkspaceId === null ? null : { workspaceId: s.projectWorkspaceId },
    },
  },
}))

const svc = await import('../workspace-session.service')

beforeEach(() => {
  s.projectsInWorkspace = new Set()
  s.sessionRow = null
  s.updateManyCalls = []
  s.primarySession = null
  s.listedSessions = []
  s.findManySessionCalls = []
  s.createCalls = []
  s.upsertCalls = []
  s.deleteManyCount = 0
  s.findManyAttached = []
  s.projectWorkspaceId = null
})

describe('upgradeProjectSessionToWorkspace', () => {
  it('converts a legacy project session in place and returns its project', async () => {
    s.sessionRow = { contextType: 'project', contextId: 'p1', workspaceId: null }
    s.projectWorkspaceId = 'ws-1'

    await expect(svc.upgradeProjectSessionToWorkspace('ws-1', 'sess-1')).resolves.toBe('p1')
    expect(s.sessionRow).toMatchObject({ contextType: 'workspace', contextId: 'p1', workspaceId: 'ws-1' })
    await expect(svc.assertWorkspaceSessionInWorkspace('ws-1', 'sess-1')).resolves.toBeUndefined()
  })

  it('leaves a project session from another workspace alone', async () => {
    s.sessionRow = { contextType: 'project', contextId: 'p1', workspaceId: null }
    s.projectWorkspaceId = 'ws-other'

    await expect(svc.upgradeProjectSessionToWorkspace('ws-1', 'sess-1')).resolves.toBeNull()
    expect(s.updateManyCalls).toHaveLength(0)
    await expect(svc.assertWorkspaceSessionInWorkspace('ws-1', 'sess-1')).rejects.toMatchObject({
      code: 'not_workspace_session',
    })
  })

  it('is a no-op for sessions that are already workspace-scoped', async () => {
    s.sessionRow = { contextType: 'workspace', contextId: 'p1', workspaceId: 'ws-1' }

    await expect(svc.upgradeProjectSessionToWorkspace('ws-1', 'sess-1')).resolves.toBeNull()
    expect(s.updateManyCalls).toHaveLength(0)
  })

  it('returns null for an unknown session', async () => {
    await expect(svc.upgradeProjectSessionToWorkspace('ws-1', 'missing')).resolves.toBeNull()
  })
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

  it('leaves the session unpinned without an anchor and records the owner', async () => {
    const res = await svc.createWorkspaceSession('ws-1', { createdByUserId: 'user-1' })
    expect(res.contextId).toBeNull()
    expect(s.createCalls[0].data.contextId).toBeNull()
    expect(s.createCalls[0].data.createdByUserId).toBe('user-1')
  })

  it('does not stamp an owner on a project-anchored session', async () => {
    s.projectsInWorkspace = new Set(['p1'])
    await svc.createWorkspaceSession('ws-1', { anchorProjectId: 'p1', createdByUserId: 'user-1' })
    expect(s.createCalls[0].data.createdByUserId).toBeNull()
  })

  it('pins to the anchor project and always attaches it read-write', async () => {
    s.projectsInWorkspace = new Set(['p1', 'p2'])
    const res = await svc.createWorkspaceSession('ws-1', {
      anchorProjectId: 'p1',
      attachProjectIds: ['p2'],
      attachMode: 'readonly',
    })
    expect(res.contextId).toBe('p1')
    expect(s.createCalls[0].data.contextId).toBe('p1')
    expect(res.attached).toEqual([
      { id: 'csp-0', projectId: 'p1', attachMode: 'readwrite' },
      { id: 'csp-1', projectId: 'p2', attachMode: 'readonly' },
    ])
  })

  it('rejects an anchor from another workspace', async () => {
    s.projectsInWorkspace = new Set()
    await expect(
      svc.createWorkspaceSession('ws-1', { anchorProjectId: 'p-other' }),
    ).rejects.toMatchObject({ code: 'project_not_in_workspace' })
    expect(s.createCalls).toHaveLength(0)
  })
})

describe('pinWorkspaceSessionToProject', () => {
  it('pins an unpinned side chat whose only attachment is the project', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', contextId: null }
    s.findManyAttached = [{ id: 'a', projectId: 'p1', attachMode: 'readwrite' }]
    expect(await svc.pinWorkspaceSessionToProject('sess-1', 'p1')).toEqual({ pinned: true, changed: true })
    expect(s.updateManyCalls[0].data).toEqual({ contextId: 'p1' })
  })

  it('reports an existing pin to the same project without rewriting it', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', contextId: 'p1' }
    expect(await svc.pinWorkspaceSessionToProject('sess-1', 'p1')).toEqual({ pinned: true, changed: false })
    expect(s.updateManyCalls).toHaveLength(0)
  })

  it('does not re-pin a session anchored to another project', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', contextId: 'p-other' }
    expect(await svc.pinWorkspaceSessionToProject('sess-1', 'p1')).toEqual({ pinned: false, changed: false })
    expect(s.updateManyCalls).toHaveLength(0)
  })

  it('pins a legacy primary session when it is otherwise eligible', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', contextId: null, isPrimary: true }
    s.findManyAttached = [{ id: 'a', projectId: 'p1', attachMode: 'readwrite' }]
    expect(await svc.pinWorkspaceSessionToProject('sess-1', 'p1')).toEqual({ pinned: true, changed: true })
  })

  it('does not pin a chat that spans other projects', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', contextId: null }
    s.findManyAttached = [
      { id: 'a', projectId: 'p1', attachMode: 'readwrite' },
      { id: 'b', projectId: 'p2', attachMode: 'readwrite' },
    ]
    expect(await svc.pinWorkspaceSessionToProject('sess-1', 'p1')).toEqual({ pinned: false, changed: false })
    expect(s.updateManyCalls).toHaveLength(0)
  })

  it('ignores project-scoped sessions', async () => {
    s.sessionRow = { contextType: 'project', workspaceId: null, contextId: 'p1' }
    expect(await svc.pinWorkspaceSessionToProject('sess-1', 'p1')).toEqual({ pinned: false, changed: false })
  })
})

describe('getOrCreateDefaultWorkspaceSession', () => {
  it('creates a personal chat when the caller has none', async () => {
    const session = await svc.getOrCreateDefaultWorkspaceSession('ws-personal', 'user-1')
    expect(session.isPrimary).toBeUndefined()
    expect(s.createCalls[0].data).toMatchObject({
      workspaceId: 'ws-personal',
      contextType: 'workspace',
      createdByUserId: 'user-1',
      name: 'Chat',
    })
    expect(s.createCalls[0].data.isPrimary).toBeUndefined()
  })

  it('reuses the caller\'s most recent chat', async () => {
    s.primarySession = { id: 'sess-recent', createdByUserId: 'user-1' }
    const session = await svc.getOrCreateDefaultWorkspaceSession('ws-personal', 'user-1')
    expect(session.id).toBe('sess-recent')
    expect(s.createCalls).toHaveLength(0)
  })
})

describe('listWorkspaceSessions', () => {
  it('returns only the caller\'s chats', async () => {
    s.listedSessions = [{ id: 'mine' }]
    const sessions = await svc.listWorkspaceSessions('ws-1', 'user-1')
    expect(sessions).toEqual([{ id: 'mine' }])
    expect(s.findManySessionCalls[0].where).toMatchObject({
      workspaceId: 'ws-1',
      createdByUserId: 'user-1',
      contextType: 'workspace',
    })
  })
})

describe('assertWorkspaceSessionAccess', () => {
  it('allows the owner and ownerless sessions', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', createdByUserId: 'user-1' }
    await expect(svc.assertWorkspaceSessionAccess('ws-1', 'sess-1', 'user-1')).resolves.toBeUndefined()
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', createdByUserId: null }
    await expect(svc.assertWorkspaceSessionAccess('ws-1', 'sess-1', 'user-2')).resolves.toBeUndefined()
  })

  it('hides a session owned by someone else', async () => {
    s.sessionRow = { contextType: 'workspace', workspaceId: 'ws-1', createdByUserId: 'user-1' }
    await expect(svc.assertWorkspaceSessionAccess('ws-1', 'sess-1', 'user-2')).rejects.toMatchObject({
      code: 'session_not_found',
    })
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
