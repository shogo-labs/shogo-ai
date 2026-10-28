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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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

// A project agent's working folder is the runtime's merged root
// (`.workspace-roots/proj-<projectId>`), so `plans/`, `memory/` and `research/`
// files it writes live only there — never in `workspaces/<projectId>`. Cloud
// already reads an unscoped path from that root; desktop said
// `file_not_found` for a file that exists (SHO-242).
describe('desktop shared-file mint from a project runtime merged root', () => {
  const anchorRoot = () => join(workspacesDir, '.workspace-roots', 'proj-proj-a')

  beforeAll(() => {
    mkdirSync(join(anchorRoot(), 'plans'), { recursive: true })
    writeFileSync(join(anchorRoot(), 'plans', 'a.md'), '# the plan\n')
  })

  it('mints and serves a file that exists only in the merged root', async () => {
    const { download, mint } = apps()
    const minted = await mint.request('/projects/proj-a/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'plans/a.md' }),
    })
    expect(minted.status).toBe(200)
    const { url, path } = await minted.json() as { url: string; path: string }
    expect(path).toBe('plans/a.md')

    const served = await download.fetch(new Request(`http://localhost/api/f/${url.split('/f/')[1]}`))
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('# the plan\n')
  })

  it('prefers the project root when the file is in both places', async () => {
    const { mint } = apps()
    mkdirSync(join(workspaceProjectDir(), 'plans'), { recursive: true })
    writeFileSync(join(workspaceProjectDir(), 'plans', 'both.md'), 'project copy')
    mkdirSync(join(anchorRoot(), 'plans'), { recursive: true })
    writeFileSync(join(anchorRoot(), 'plans', 'both.md'), 'merged copy')

    const minted = await mint.request('/projects/proj-a/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'plans/both.md' }),
    })
    expect(minted.status).toBe(200)

    const resolved = await resolveLocalSharedFileTarget({
      projectId: 'proj-a',
      workspaceId: 'ws-1',
      path: 'plans/both.md',
      workspacesDir,
    })
    expect(resolved?.target).toBe(realpathSync(join(workspaceProjectDir(), 'plans', 'both.md')))
  })

  it('treats a project with no merged root as not found instead of failing', async () => {
    projects['proj-b'] = { workspaceId: 'ws-1' }
    const resolved = await resolveLocalSharedFileTarget({
      projectId: 'proj-b',
      workspaceId: 'ws-1',
      path: 'plans/b.md',
      workspacesDir,
    })
    expect(resolved).toBeNull()

    const { mint } = apps()
    const minted = await mint.request('/projects/proj-b/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'plans/b.md' }),
    })
    expect(minted.status).toBe(400)
    expect((await minted.json()).error.code).toBe('file_not_found')
  })

  it('refuses a merged-root symlink into another workspace', async () => {
    mkdirSync(join(workspacesDir, 'other-proj'), { recursive: true })
    writeFileSync(join(workspacesDir, 'other-proj', 'notes.md'), 'other workspace')
    projects['other-proj'] = { workspaceId: 'ws-2' }
    symlinkSync(join(workspacesDir, 'other-proj'), join(anchorRoot(), 'other-proj'))

    expect(
      await resolveLocalSharedFileTarget({
        projectId: 'proj-a',
        workspaceId: 'ws-1',
        path: 'other-proj/notes.md',
        workspacesDir,
      }),
    ).toBeNull()
  })

  it('refuses a merged-root symlink that points outside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'shared-file-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'not yours')
    symlinkSync(outside, join(anchorRoot(), 'escape'))

    try {
      expect(
        await resolveLocalSharedFileTarget({
          projectId: 'proj-a',
          workspaceId: 'ws-1',
          path: 'escape/secret.txt',
          workspacesDir,
        }),
      ).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
