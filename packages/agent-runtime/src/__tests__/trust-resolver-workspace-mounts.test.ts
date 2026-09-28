// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Trust on a workspace (merged-root) runtime. The merged root is Shogo's own
 * directory and stays trusted; a folder-linked project mounted into it is the
 * user's repo and keeps the opt-in trust gate a single-project external
 * runtime has — restricted until the owning project is trusted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { assertAllowedPath } from '../runtime-trust'
import { initTrustResolver, refreshTrust, __resetTrustForTests } from '../trust-resolver'
import { userOwnedTrustGroups, type WorkspaceMount } from '../workspace-runtime-mode'

const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('workspace runtime trust for user-owned mounts', () => {
  let base: string
  let merged: string
  let user: string
  let mounts: WorkspaceMount[]
  let requested: string[]
  const origFetch = globalThis.fetch

  beforeEach(() => {
    __resetTrustForTests()
    base = mkdtempSync(join(tmpdir(), 'shogo-trust-mounts-'))
    merged = join(base, 'merged')
    user = join(base, 'user')
    mkdirSync(merged, { recursive: true })
    mkdirSync(user, { recursive: true })
    writeFileSync(join(merged, 'MEMORY.md'), '# memory')
    writeFileSync(join(user, 'app.py'), 'app = 1\n')
    symlinkSync(user, join(merged, 'proj-ext'), DIR_LINK_TYPE)
    mounts = [{ mount: 'proj-ext', path: user, projectId: 'proj-ext', kind: 'external', runtimeEnabled: false }]
    requested = []
    process.env.SHOGO_API_URL = 'http://127.0.0.1:65500'
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    delete process.env.SHOGO_API_URL
    rmSync(base, { recursive: true, force: true })
    __resetTrustForTests()
  })

  function stubTrust(getLevel: () => 'restricted' | 'trusted'): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response(JSON.stringify({ trustLevel: getLevel(), workingMode: 'external', linkedFolders: [user] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  function init(): void {
    initTrustResolver({
      projectId: 'proj-ext',
      workspaceDir: merged,
      workingMode: 'managed',
      linkedFolders: [user],
      isWorkspaceRuntime: true,
      rootGroups: userOwnedTrustGroups(mounts),
    })
  }

  test('a folder-linked mount is restricted before trust is read; the merged root is not', () => {
    init()
    const viaMount = assertAllowedPath(join(merged, 'proj-ext', 'app.py'), 'write')
    expect(viaMount.ok).toBe(false)
    expect(viaMount.reason).toBe('restricted_mode_write')
    expect(assertAllowedPath(join(user, 'app.py'), 'write').reason).toBe('restricted_mode_write')
    expect(assertAllowedPath(join(merged, 'MEMORY.md'), 'write').ok).toBe(true)
    expect(assertAllowedPath(join(merged, 'proj-ext', 'app.py'), 'read').ok).toBe(true)
  })

  test('a restricted mount disables exec for the whole runtime', () => {
    init()
    const exec = assertAllowedPath(merged, 'exec')
    expect(exec.ok).toBe(false)
    expect(exec.reason).toBe('restricted_mode_exec')
  })

  test('refresh reads the owning project and flips the mount to trusted', async () => {
    let level: 'restricted' | 'trusted' = 'restricted'
    stubTrust(() => level)
    init()

    await refreshTrust()
    expect(requested).toEqual(['http://127.0.0.1:65500/api/internal/projects/proj-ext/trust'])
    expect(assertAllowedPath(join(merged, 'proj-ext', 'app.py'), 'write').ok).toBe(false)

    level = 'trusted'
    await refreshTrust()
    expect(assertAllowedPath(join(merged, 'proj-ext', 'app.py'), 'write').ok).toBe(true)
    expect(assertAllowedPath(merged, 'exec').ok).toBe(true)
  })

  test('a failed refresh keeps the fail-closed default', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    init()
    await refreshTrust()
    expect(assertAllowedPath(join(merged, 'proj-ext', 'app.py'), 'write').ok).toBe(false)
  })

  test('without user-owned mounts nothing is fetched and everything is trusted', async () => {
    stubTrust(() => 'restricted')
    mounts = [{ mount: 'proj-m', path: user, projectId: 'proj-m', kind: 'managed' }]
    init()
    await refreshTrust()
    expect(requested).toEqual([])
    expect(assertAllowedPath(join(merged, 'MEMORY.md'), 'write').ok).toBe(true)
    expect(assertAllowedPath(merged, 'exec').ok).toBe(true)
  })

  test('an extra folder linked to a managed project defaults open', () => {
    mounts = [
      { mount: 'proj-m', path: join(base, 'managed'), projectId: 'proj-m', kind: 'managed' },
      { mount: 'user', path: user, projectId: 'proj-m', kind: 'folder' },
    ]
    mkdirSync(join(base, 'managed'), { recursive: true })
    init()
    expect(assertAllowedPath(join(user, 'app.py'), 'write').ok).toBe(true)
  })
})
