// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop "Open folder → Trust folder" contract, end to end across the
 * runtime ↔ API boundary.
 *
 * The real slim desktop composer (`createLocalApp`) is served over HTTP and
 * the real agent-runtime trust resolver is pointed at it with the same
 * workspace runtime token the RuntimeManager hands a merged-root runtime.
 * Only the database is faked.
 *
 * Regression: the slim composer shipped without any `/api/internal/*`
 * routes, so the resolver's trust read 404'd, it failed closed, and a
 * folder-linked repo stayed read-only (no write, no exec anywhere in the
 * runtime) even after the user clicked "Trust folder".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const WORKSPACE_ID = 'ws-local-team'
const PROJECT_ID = 'proj-folder'
const OTHER_WORKSPACE_ID = 'ws-someone-else'

const projects = new Map<string, {
  workspaceId: string
  trustLevel: 'trusted' | 'restricted'
  workingMode: 'managed' | 'external'
  projectFolders: Array<{ path: string; isPrimary: boolean; lastOpenedAt: Date | null }>
}>()

const fakePrisma = {
  project: {
    findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
  },
}

process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'
process.env.BETTER_AUTH_SECRET ||= 'local-runtime-trust-test-secret'

mock.module('../../lib/prisma', async () => ({
  ...(await import('../../generated/prisma-pg/client')),
  appDatabaseUrl: () => undefined,
  prisma: fakePrisma,
}))
mock.module('@shogo-ai/sdk/cli/pkg', () => ({
  pkg: { version: '0.0.0', name: '@shogo-ai/sdk' },
  PlatformPackageManager: class {},
  NodeMissingError: class NodeMissingError extends Error {},
  isNodeAvailableOnUnix: () => Promise.resolve(false),
  isNodeAvailableOnWindows: () => Promise.resolve(false),
  _resetUnixNodeCache: () => {},
  resolveBinInvocation: (command: string) => command,
}))

const { createLocalApp } = await import('../create-local-app')
const { deriveWorkspaceRuntimeToken } = await import('../../lib/workspace-runtime-token')
const { deriveRuntimeToken } = await import('../../lib/runtime-token')
const { initTrustResolver, refreshTrust, __resetTrustForTests } = await import(
  '../../../../../packages/agent-runtime/src/trust-resolver'
)
const { assertAllowedPath } = await import('../../../../../packages/agent-runtime/src/runtime-trust')
const { userOwnedTrustGroups } = await import('../../../../../packages/agent-runtime/src/workspace-runtime-mode')

const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('desktop local API ↔ agent-runtime folder trust', () => {
  let server: ReturnType<typeof Bun.serve>
  let apiUrl: string
  let base: string
  let mergedRoot: string
  let repo: string

  beforeAll(() => {
    const { app } = createLocalApp()
    server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) })
    apiUrl = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    server.stop(true)
    delete process.env.SHOGO_API_URL
    delete process.env.RUNTIME_AUTH_SECRET
  })

  beforeEach(() => {
    __resetTrustForTests()
    base = mkdtempSync(join(tmpdir(), 'shogo-local-trust-'))
    mergedRoot = join(base, 'merged-root')
    repo = join(base, 'alignment-project-server')
    mkdirSync(mergedRoot, { recursive: true })
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(mergedRoot, 'AGENTS.md'), '# workspace')
    writeFileSync(join(repo, 'app.py'), 'app = 1\n')
    symlinkSync(repo, join(mergedRoot, PROJECT_ID), DIR_LINK_TYPE)

    projects.clear()
    projects.set(PROJECT_ID, {
      workspaceId: WORKSPACE_ID,
      trustLevel: 'restricted',
      workingMode: 'external',
      projectFolders: [{ path: repo, isPrimary: true, lastOpenedAt: new Date() }],
    })

    process.env.SHOGO_API_URL = apiUrl
    process.env.RUNTIME_AUTH_SECRET = deriveWorkspaceRuntimeToken(WORKSPACE_ID)
  })

  /** Boot the resolver the way server.ts does for an anchored folder project. */
  function bootWorkspaceRuntime(): void {
    initTrustResolver({
      projectId: `ws:proj:${PROJECT_ID}`,
      workspaceDir: mergedRoot,
      workingMode: 'managed',
      linkedFolders: [repo],
      readonlyRoots: [],
      isWorkspaceRuntime: true,
      rootGroups: userOwnedTrustGroups([
        { mount: PROJECT_ID, path: repo, projectId: PROJECT_ID, kind: 'external', runtimeEnabled: false },
      ]),
    })
  }

  function trustFolder(trusted: boolean): void {
    projects.get(PROJECT_ID)!.trustLevel = trusted ? 'trusted' : 'restricted'
  }

  test('the trust route is served by the desktop composer', async () => {
    const res = await fetch(`${apiUrl}/api/internal/projects/${PROJECT_ID}/trust`, {
      headers: { 'x-runtime-token': process.env.RUNTIME_AUTH_SECRET! },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      trustLevel: 'restricted',
      workingMode: 'external',
      linkedFolders: [repo],
    })
  })

  test('a freshly opened folder is read-only until the user trusts it', async () => {
    bootWorkspaceRuntime()
    await refreshTrust()

    expect(assertAllowedPath(join(repo, 'app.py'), 'read').ok).toBe(true)
    expect(assertAllowedPath(join(repo, 'NEW.txt'), 'write')).toMatchObject({ ok: false, reason: 'restricted_mode_write' })
    expect(assertAllowedPath(repo, 'exec')).toMatchObject({ ok: false, reason: 'restricted_mode_exec' })
  })

  test('"Trust folder" unlocks write and exec in the running agent', async () => {
    bootWorkspaceRuntime()
    await refreshTrust()
    expect(assertAllowedPath(repo, 'exec').ok).toBe(false)

    trustFolder(true)
    await refreshTrust()

    expect(assertAllowedPath(join(repo, 'NEW.txt'), 'write').ok).toBe(true)
    expect(assertAllowedPath(repo, 'exec').ok).toBe(true)
    expect(assertAllowedPath(mergedRoot, 'exec').ok).toBe(true)
  })

  test('an already-trusted folder is writable as soon as the runtime boots', async () => {
    trustFolder(true)
    bootWorkspaceRuntime()
    await refreshTrust()

    expect(assertAllowedPath(join(repo, 'app.py'), 'write').ok).toBe(true)
    expect(assertAllowedPath(repo, 'exec').ok).toBe(true)
  })

  test('revoking trust takes effect on the next refresh', async () => {
    trustFolder(true)
    bootWorkspaceRuntime()
    await refreshTrust()
    expect(assertAllowedPath(repo, 'exec').ok).toBe(true)

    trustFolder(false)
    await refreshTrust()

    expect(assertAllowedPath(join(repo, 'app.py'), 'write')).toMatchObject({ ok: false, reason: 'restricted_mode_write' })
  })

  test('a single-project runtime token also reads its own trust', async () => {
    const res = await fetch(`${apiUrl}/api/internal/projects/${PROJECT_ID}/trust`, {
      headers: { 'x-runtime-token': deriveRuntimeToken(PROJECT_ID) },
    })
    expect(res.status).toBe(200)
  })

  test('requests without a valid runtime token for the project are rejected', async () => {
    const url = `${apiUrl}/api/internal/projects/${PROJECT_ID}/trust`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { 'x-runtime-token': 'wrt_v1_forged' } })).status).toBe(401)
    expect(
      (await fetch(url, { headers: { 'x-runtime-token': deriveWorkspaceRuntimeToken(OTHER_WORKSPACE_ID) } })).status,
    ).toBe(401)
    expect(
      (await fetch(url, { headers: { 'x-runtime-token': deriveRuntimeToken('some-other-project') } })).status,
    ).toBe(401)
  })

  test('a runtime from another workspace cannot unlock this folder', async () => {
    trustFolder(true)
    process.env.RUNTIME_AUTH_SECRET = deriveWorkspaceRuntimeToken(OTHER_WORKSPACE_ID)
    bootWorkspaceRuntime()
    await refreshTrust()

    expect(assertAllowedPath(repo, 'exec')).toMatchObject({ ok: false, reason: 'restricted_mode_exec' })
  })

  afterEach(() => {
    __resetTrustForTests()
    rmSync(base, { recursive: true, force: true })
  })
})
