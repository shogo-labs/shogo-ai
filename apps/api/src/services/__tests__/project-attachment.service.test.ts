// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// project-attachment.service — persistent project↔project attachments and
// the per-project pinned workspace session that materializes them.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface ProjectRow {
  id: string
  workspaceId: string
  name?: string | null
}

interface State {
  projects: Map<string, ProjectRow>
  attachments: Array<{ id: string; projectId: string; attachedProjectId: string; attachMode: string }>
  pinnedSession: { id: string; contextId: string } | null
  sessionProjects: Array<{ sessionId: string; projectId: string; attachMode: string }>
  folders: Array<{ projectId: string; path: string }>
}

const s: State = {
  projects: new Map(),
  attachments: [],
  pinnedSession: null,
  sessionProjects: [],
  folders: [],
}

let idSeq = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async (args: any) => s.projects.get(args.where.id) ?? null,
    },
    projectAttachment: {
      findMany: async (args: any) => {
        const rows = s.attachments.filter((a) => a.projectId === args.where.projectId)
        if (args.include?.attached) {
          return rows.map((r) => ({
            ...r,
            attached: { id: r.attachedProjectId, name: s.projects.get(r.attachedProjectId)?.name ?? null },
          }))
        }
        return rows
      },
      upsert: async (args: any) => {
        const { projectId, attachedProjectId } = args.where.projectId_attachedProjectId
        let row = s.attachments.find((a) => a.projectId === projectId && a.attachedProjectId === attachedProjectId)
        if (row) {
          row.attachMode = args.update.attachMode
        } else {
          row = { id: `att-${++idSeq}`, ...args.create }
          s.attachments.push(row)
        }
        return {
          ...row,
          attached: { id: row.attachedProjectId, name: s.projects.get(row.attachedProjectId)?.name ?? null },
        }
      },
      deleteMany: async (args: any) => {
        const before = s.attachments.length
        s.attachments = s.attachments.filter(
          (a) => !(a.projectId === args.where.projectId && a.attachedProjectId === args.where.attachedProjectId),
        )
        return { count: before - s.attachments.length }
      },
    },
    projectFolder: {
      findMany: async (args: any) => s.folders.filter((f) => f.projectId === args.where.projectId),
    },
    chatSession: {
      findFirst: async (_args: any) => s.pinnedSession,
      create: async (args: any) => {
        s.pinnedSession = { id: `sess-${++idSeq}`, contextId: args.data.contextId }
        return { id: s.pinnedSession.id }
      },
    },
    chatSessionProject: {
      findMany: async (args: any) => s.sessionProjects.filter((p) => p.sessionId === args.where.sessionId),
      deleteMany: async (args: any) => {
        const ids: string[] = args.where.projectId.in
        const before = s.sessionProjects.length
        s.sessionProjects = s.sessionProjects.filter(
          (p) => !(p.sessionId === args.where.sessionId && ids.includes(p.projectId)),
        )
        return { count: before - s.sessionProjects.length }
      },
      upsert: async (args: any) => {
        const { sessionId, projectId } = args.where.sessionId_projectId
        let row = s.sessionProjects.find((p) => p.sessionId === sessionId && p.projectId === projectId)
        if (row) row.attachMode = args.update.attachMode
        else s.sessionProjects.push({ sessionId, projectId, attachMode: args.create.attachMode })
        return {}
      },
    },
  },
}))

const svc = await import('../project-attachment.service')

beforeEach(() => {
  s.projects = new Map([
    ['anchor', { id: 'anchor', workspaceId: 'ws1', name: 'Anchor' }],
    ['b', { id: 'b', workspaceId: 'ws1', name: 'Project B' }],
    ['c', { id: 'c', workspaceId: 'ws1', name: 'Project C' }],
    ['other-ws', { id: 'other-ws', workspaceId: 'ws2', name: 'Foreign' }],
  ])
  s.attachments = []
  s.pinnedSession = null
  s.sessionProjects = []
  s.folders = []
  idSeq = 0
})

describe('attachProjectToProject', () => {
  it('rejects self-attach', async () => {
    await expect(svc.attachProjectToProject('anchor', 'anchor')).rejects.toMatchObject({ code: 'self_attach' })
  })

  it('rejects cross-workspace attach', async () => {
    await expect(svc.attachProjectToProject('anchor', 'other-ws')).rejects.toMatchObject({ code: 'cross_workspace' })
  })

  it('rejects unknown attached project', async () => {
    await expect(svc.attachProjectToProject('anchor', 'nope')).rejects.toMatchObject({ code: 'project_not_found' })
  })

  it('attaches and seeds the pinned session with [anchor, attached]', async () => {
    const row = await svc.attachProjectToProject('anchor', 'b', 'readonly')
    expect(row.attachedProjectId).toBe('b')
    expect(row.attachMode).toBe('readonly')
    // Pinned session created + synced: anchor (readwrite) + b (readonly).
    expect(s.pinnedSession).not.toBeNull()
    const sid = s.pinnedSession!.id
    const rows = s.sessionProjects.filter((p) => p.sessionId === sid)
    expect(rows.find((r) => r.projectId === 'anchor')?.attachMode).toBe('readwrite')
    expect(rows.find((r) => r.projectId === 'b')?.attachMode).toBe('readonly')
  })

  it('is idempotent — re-attach updates attachMode', async () => {
    await svc.attachProjectToProject('anchor', 'b', 'readwrite')
    await svc.attachProjectToProject('anchor', 'b', 'readonly')
    expect(s.attachments.filter((a) => a.attachedProjectId === 'b')).toHaveLength(1)
    expect(s.attachments[0].attachMode).toBe('readonly')
  })
})

describe('detachProjectFromProject', () => {
  it('removes the attachment and resyncs the session', async () => {
    await svc.attachProjectToProject('anchor', 'b')
    await svc.attachProjectToProject('anchor', 'c')
    const removed = await svc.detachProjectFromProject('anchor', 'b')
    expect(removed).toBe(true)
    const sid = s.pinnedSession!.id
    const ids = s.sessionProjects.filter((p) => p.sessionId === sid).map((p) => p.projectId).sort()
    expect(ids).toEqual(['anchor', 'c'])
  })

  it('returns false when nothing was attached', async () => {
    expect(await svc.detachProjectFromProject('anchor', 'b')).toBe(false)
  })
})

describe('getOrCreatePinnedWorkspaceSession', () => {
  it('creates once then returns the same session', async () => {
    const first = await svc.getOrCreatePinnedWorkspaceSession('anchor')
    expect(first.workspaceId).toBe('ws1')
    const second = await svc.getOrCreatePinnedWorkspaceSession('anchor')
    expect(second.id).toBe(first.id)
  })
})

describe('getAnchorLocalFolders', () => {
  it('returns the anchor folder paths', async () => {
    s.folders = [
      { projectId: 'anchor', path: '/Users/me/data' },
      { projectId: 'b', path: '/Users/me/other' },
    ]
    expect(await svc.getAnchorLocalFolders('anchor')).toEqual(['/Users/me/data'])
  })
})
