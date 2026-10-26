// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The reported bug, end to end: a workspace agent shares a file that lives in
 * a mounted project and the URL it hands back must serve the file's bytes.
 *
 * Nothing here is stubbed between the two halves that disagreed in SHO-67 —
 * the real `share_file` tool signs a path, the real desktop mint route signs
 * it into a token, and the real desktop download route reads it back. Only the
 * HTTP hop between the runtime and the API is short-circuited into the same
 * Hono app, and `prisma` is a stub for the one project lookup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projects: Record<string, { workspaceId: string }> = {}
mock.module('../apps/api/src/lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const project = projects[where.id]
        return project ? { workspaceId: project.workspaceId, workingMode: 'managed', projectFolders: [] } : null
      },
    },
  },
}))

import { createTools, type ToolContext } from '../packages/agent-runtime/src/gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from '../packages/agent-runtime/src/__tests__/helpers/test-trust'
import { FileStateCache } from '../packages/agent-runtime/src/file-state-cache'
import { resolveLocalSharedFileTarget } from '../apps/api/src/lib/local-shared-file-target'
import { runtimeInternalRoutes } from '../apps/api/src/routes/internal-runtime-routes'
import { localSharedFileRoutes } from '../apps/api/src/routes/local-shared-files'

let root = ''
let workspacesDir = ''
let mergedRoot = ''

const savedEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let mint: ReturnType<typeof runtimeInternalRoutes>
let download: ReturnType<typeof localSharedFileRoutes>
const mintCalls: Array<{ url: string; body: any }> = []

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'share-file-roundtrip-')))
  workspacesDir = join(root, 'workspaces')
  mergedRoot = join(workspacesDir, '.workspace-roots', 'ws-1')

  mkdirSync(mergedRoot, { recursive: true })
  for (const id of ['proj-a', 'proj-b']) {
    mkdirSync(join(workspacesDir, id, 'out'), { recursive: true })
    symlinkSync(join(workspacesDir, id), join(mergedRoot, id))
  }
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'report.mp4'), 'video bytes')
  writeFileSync(join(mergedRoot, 'summary.csv'), 'a,b\n')

  projects['proj-a'] = { workspaceId: 'ws-1' }
  projects['proj-b'] = { workspaceId: 'ws-1' }

  setEnv('BETTER_AUTH_SECRET', 'share-file-roundtrip-secret')
  setEnv('SHOGO_API_URL', 'http://api.test')
  setEnv('RUNTIME_AUTH_SECRET', 'pod-secret')
  setEnv('WORKSPACE_RUNTIME', 'true')
  setEnv('WORKSPACE_ID', 'ws-1')
  setEnv('WORKSPACE_PROJECT_IDS', 'proj-a,proj-b')
  // The real workspace runtime boots with each member's real path in
  // LINKED_FOLDERS (the mounts are symlinks); without it the tool's own
  // containment check refuses `<projectId>/…`, which is a different gate.
  setEnv('LINKED_FOLDERS', JSON.stringify([join(workspacesDir, 'proj-a'), join(workspacesDir, 'proj-b')]))

  mint = runtimeInternalRoutes({
    authenticate: async () => ({ kind: 'sa' }),
    resolveSharedFileTarget: (scope) => resolveLocalSharedFileTarget({ ...scope, workspacesDir }),
  })
  download = localSharedFileRoutes({ workspacesDir })
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearTrustForTests()
  rmSync(root, { recursive: true, force: true })
})

const originalFetch = globalThis.fetch

beforeEach(() => {
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
  mintCalls.length = 0
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    mintCalls.push({ url, body })
    // The runtime calls `/api/internal/...`; `runtimeInternalRoutes` is the app
    // that the API mounts under that prefix.
    const path = new URL(url).pathname.replace(/^\/api\/internal/, '')
    return mint.request(`http://api.test${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
})

function ctx(): ToolContext {
  trustWorkspaceForTests(mergedRoot)
  return {
    workspaceDir: mergedRoot,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: 'ws:ws-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fileStateCache: new FileStateCache(mergedRoot),
    autoRouting: false,
  } as ToolContext
}

async function share(params: Record<string, any>) {
  const tool = createTools(ctx()).find((t) => t.name === 'share_file')
  if (!tool) throw new Error('missing share_file tool')
  const result = await tool.execute('t', params)
  return result.details as any
}

async function downloadBytes(url: string) {
  const token = url.split('/f/')[1]
  const served = await download.fetch(new Request(`http://localhost/api/f/${token}`))
  return { status: served.status, text: await served.text() }
}

describe('share_file → desktop mint → desktop download', () => {
  test('a file inside a mounted project serves its bytes (with and without project_id)', async () => {
    const picked = await share({ path: 'proj-a/out/report.mp4', project_id: 'proj-a' })
    expect(picked.ok).toBe(true)
    expect(picked.path).toBe('out/report.mp4')
    expect(await downloadBytes(picked.url)).toEqual({ status: 200, text: 'video bytes' })

    const inferred = await share({ path: 'proj-a/out/report.mp4' })
    expect(inferred.ok).toBe(true)
    expect(inferred.projectId).toBe('proj-a')
    expect(await downloadBytes(inferred.url)).toEqual({ status: 200, text: 'video bytes' })
  })

  test('a workspace-root file mints a workspace link and still serves', async () => {
    const result = await share({ path: 'summary.csv', project_id: 'proj-b' })
    expect(result.ok).toBe(true)
    expect(result.projectId).toBeUndefined()
    expect(await downloadBytes(result.url)).toEqual({ status: 200, text: 'a,b\n' })
  })

  test('a link already minted with the redundant prefix still resolves', async () => {
    const minted = await mint.request('/projects/proj-a/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'proj-a/out/report.mp4' }),
    })
    const { url } = await minted.json() as { url: string }
    expect(await downloadBytes(url)).toEqual({ status: 200, text: 'video bytes' })
  })

  test('a path that cannot be served fails the mint instead of returning a dead URL', async () => {
    const missingTool = await share({ path: 'proj-a/out/missing.mp4' })
    expect(missingTool.url).toBeUndefined()
    expect(String(missingTool.error)).toContain('File not found')

    const missingMint = await mint.request('/projects/proj-a/shared-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'out/missing.mp4' }),
    })
    expect(missingMint.status).toBe(400)
    expect((await missingMint.json()).error.code).toBe('file_not_found')
  })

  test('the workspace link for another workspace\'s project is not served', async () => {
    projects['proj-b'] = { workspaceId: 'ws-other' }
    try {
      const forged = await mint.request('/workspaces/ws-1/shared-files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'proj-b/out/report.mp4' }),
      })
      expect(forged.status).toBe(400)
    } finally {
      projects['proj-b'] = { workspaceId: 'ws-1' }
    }
  })
})
