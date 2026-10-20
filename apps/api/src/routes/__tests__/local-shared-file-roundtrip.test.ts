// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mint → download round trip for a desktop shared-file link (SHO-67).
 *
 * The mint route and the download route used to resolve `path` independently,
 * so a link minted from a workspace runtime (workspace-relative path) for a
 * project-scoped download 404'd. Both now go through
 * `resolveLocalSharedFileTarget`; this file proves the URL the mint hands out
 * serves the file.
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

const { runtimeInternalRoutes } = await import('../internal-runtime-routes')
const { localSharedFileRoutes } = await import('../local-shared-files')
const { resolveLocalSharedFileTarget } = await import('../../lib/local-shared-file-target')

let workspacesDir = ''
const originalSecret = process.env.BETTER_AUTH_SECRET

beforeAll(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'shared-file-roundtrip-'))
  const mergedRoot = join(workspacesDir, '.workspace-roots', 'ws-1')
  mkdirSync(join(workspaceProjectDir(), 'out'), { recursive: true })
  writeFileSync(join(workspaceProjectDir(), 'out', 'report.mp4'), 'video bytes')
  mkdirSync(mergedRoot, { recursive: true })
  symlinkSync(workspaceProjectDir(), join(mergedRoot, 'proj-a'))
})

function workspaceProjectDir(): string {
  return join(workspacesDir, 'proj-a')
}

afterAll(() => {
  rmSync(workspacesDir, { recursive: true, force: true })
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = originalSecret
})

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = 'shared-file-roundtrip-secret'
  for (const key of Object.keys(projects)) delete projects[key]
  projects['proj-a'] = { workspaceId: 'ws-1' }
})

function apps() {
  const download = localSharedFileRoutes({ workspacesDir })
  const mint = runtimeInternalRoutes({
    authenticate: async () => ({ kind: 'sa' }),
    resolveSharedFileTarget: (scope) => resolveLocalSharedFileTarget({ ...scope, workspacesDir }),
  })
  return { download, mint }
}

describe('desktop shared-file mint → download', () => {
  it('serves the file when the agent signs a workspace-relative path', async () => {
    const { download, mint } = apps()
    const minted = await mint.request('/projects/proj-a/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'proj-a/out/report.mp4' }),
    })
    expect(minted.status).toBe(200)
    const { url, path } = await minted.json() as { url: string; path: string }
    expect(path).toBe('out/report.mp4')

    const token = url.split('/f/')[1]
    const served = await download.fetch(new Request(`http://localhost/api/f/${token}`))
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('video bytes')
    expect(served.headers.get('content-disposition')).toBe('attachment; filename="report.mp4"')
  })

  it('serves the file through a workspace link when no project owns it', async () => {
    const { download, mint } = apps()
    writeFileSync(join(workspacesDir, '.workspace-roots', 'ws-1', 'summary.csv'), 'a,b\n')
    const minted = await mint.request('/workspaces/ws-1/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'summary.csv' }),
    })
    expect(minted.status).toBe(200)
    const { url } = await minted.json() as { url: string }

    const served = await download.fetch(new Request(`http://localhost/api/f/${url.split('/f/')[1]}`))
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('a,b\n')
  })

  it('refuses to mint a link for a path it cannot serve', async () => {
    const { mint } = apps()
    const minted = await mint.request('/projects/proj-a/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'proj-a/out/missing.mp4' }),
    })
    expect(minted.status).toBe(400)
    expect((await minted.json()).error.code).toBe('file_not_found')
  })
})
