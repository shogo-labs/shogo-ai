// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// anchorRuntimeOpts — a Remote-SSH anchor's own folder row is a remote path
// and must never be passed to the runtime as a local folder.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface State {
  sessionContextId: string | null
  projects: Map<string, { id: string; remoteHostId?: string | null }>
  folders: Array<{ projectId: string; path: string }>
}

const s: State = { sessionContextId: null, projects: new Map(), folders: [] }

mock.module('../prisma', () => ({
  prisma: {
    chatSession: {
      findUnique: async () => ({ contextId: s.sessionContextId }),
    },
    project: {
      findUnique: async (args: any) => s.projects.get(args.where.id) ?? null,
    },
    projectFolder: {
      findMany: async (args: any) => s.folders.filter((f) => f.projectId === args.where.projectId),
    },
  },
}))

mock.module('../../services/workspace-session.service', () => ({
  assertWorkspaceSessionInWorkspace: async () => {},
  getAttachedProjects: async () => [],
}))

const { anchorRuntimeOpts } = await import('../workspace-runtime-args')

beforeEach(() => {
  s.sessionContextId = 'anchor'
  s.projects = new Map([['anchor', { id: 'anchor', remoteHostId: null }]])
  s.folders = [{ projectId: 'anchor', path: '/Users/me/data' }]
})

describe('anchorRuntimeOpts localFolders', () => {
  it('returns the folders of a local anchor', async () => {
    const extra = await anchorRuntimeOpts('sess', [])
    expect(extra.anchorProjectId).toBe('anchor')
    expect(extra.localFolders).toEqual(['/Users/me/data'])
  })

  it('returns no local folders for a Remote-SSH anchor', async () => {
    s.projects.set('anchor', { id: 'anchor', remoteHostId: 'host-1' })
    s.folders = [{ projectId: 'anchor', path: '/home/dev/app' }]
    const extra = await anchorRuntimeOpts('sess', [])
    expect(extra.anchorProjectId).toBe('anchor')
    expect(extra.localFolders).toEqual([])
  })
})
