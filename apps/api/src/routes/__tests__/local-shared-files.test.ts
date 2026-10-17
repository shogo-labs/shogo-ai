// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop download route for share_file links. A workspace-scoped link (no
 * project) is served from the workspace runtime's merged root, including
 * files inside a member project mounted there, and nothing outside it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const projects: Record<string, { workspaceId: string }> = {}
mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const project = projects[where.id]
        return project ? { workspaceId: project.workspaceId, workingMode: 'managed', projectFolders: [] } : null
      },
    },
  },
}))

const { signSharedFileToken } = await import('../../lib/shared-file-token')
const { localSharedFileRoutes } = await import('../local-shared-files')

const originalSecret = process.env.BETTER_AUTH_SECRET
let workspacesDir = ''
let outsideDir = ''

function workspaceLink(path: string, workspaceId = 'ws-1') {
  return signSharedFileToken({ workspaceId, path, exp: Math.floor(Date.now() / 1000) + 3600 })
}

beforeAll(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'local-shared-files-'))
  outsideDir = mkdtempSync(join(tmpdir(), 'local-shared-files-outside-'))
  const mergedRoot = join(workspacesDir, '.workspace-roots', 'ws-1')
  mkdirSync(join(mergedRoot, 'exports'), { recursive: true })
  writeFileSync(join(mergedRoot, 'exports', 'summary.csv'), 'a,b\n1,2\n')

  mkdirSync(join(workspacesDir, 'proj-a'), { recursive: true })
  writeFileSync(join(workspacesDir, 'proj-a', 'report.txt'), 'project file')
  symlinkSync(join(workspacesDir, 'proj-a'), join(mergedRoot, 'proj-a'))

  mkdirSync(join(workspacesDir, 'proj-other'), { recursive: true })
  writeFileSync(join(workspacesDir, 'proj-other', 'secret.txt'), 'other workspace')
  symlinkSync(join(workspacesDir, 'proj-other'), join(mergedRoot, 'proj-other'))

  writeFileSync(join(outsideDir, 'host.txt'), 'host file')
  symlinkSync(outsideDir, join(mergedRoot, 'escape'))
})

afterAll(() => {
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = originalSecret
})

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = 'local-shared-file-test-secret'
  for (const key of Object.keys(projects)) delete projects[key]
  projects['proj-a'] = { workspaceId: 'ws-1' }
  projects['proj-other'] = { workspaceId: 'ws-2' }
})

describe('local shared file routes: workspace links', () => {
  it('serves a file at the workspace merged root', async () => {
    const app = localSharedFileRoutes({ workspacesDir })
    const response = await app.fetch(new Request(`http://localhost/api/f/${workspaceLink('exports/summary.csv')}`))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('a,b\n1,2\n')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="summary.csv"')
  })

  it('serves a file inside a member project of the same workspace', async () => {
    const app = localSharedFileRoutes({ workspacesDir })
    const response = await app.fetch(new Request(`http://localhost/api/f/${workspaceLink('proj-a/report.txt')}`))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('project file')
  })

  it('refuses links that leave the workspace', async () => {
    const app = localSharedFileRoutes({ workspacesDir })
    for (const path of ['proj-other/secret.txt', 'escape/host.txt', 'exports/missing.csv']) {
      const response = await app.fetch(new Request(`http://localhost/api/f/${workspaceLink(path)}`))
      expect(response.status).toBe(404)
    }
    const otherWorkspace = await app.fetch(new Request(`http://localhost/api/f/${workspaceLink('exports/summary.csv', 'ws-2')}`))
    expect(otherWorkspace.status).toBe(404)
  })
})
