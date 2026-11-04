// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Authorisation for the Personal workspace's shared root (SHO-285 Update 2,
 * section F).
 *
 *   bun test apps/api/src/routes/__tests__/workspace-root.test.ts
 *
 * The manifest and presign routes are the only way a desktop reaches the
 * canonical copy of a Personal's root, so the three refusals matter as much as
 * the happy path: signed out is 401, not a member is 403, and a non-Personal
 * workspace is 400 rather than a cheerful "synced" for a root nothing stores.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

const PERSONAL = 'ws-personal'
const TEAM = 'ws-team'
const MEMBER = 'user-member'

let access: Record<string, boolean>
let kinds: Record<string, string | null>
let manifestCalls: string[]
let presignCalls: string[]
let manifestShouldThrow: boolean

mock.module('../../services/workspace.service', () => ({
  hasWorkspaceAccess: async (workspaceId: string, userId: string) =>
    userId === MEMBER && access[workspaceId] === true,
  getWorkspaceKind: async (workspaceId: string) => kinds[workspaceId] ?? null,
}))

mock.module('../../lib/workspace-root-files', () => ({
  readWorkspaceRootManifest: async (workspaceId: string) => {
    manifestCalls.push(workspaceId)
    if (manifestShouldThrow) throw new Error('store unavailable')
    return { workspaceId, files: [{ path: 'MEMORY.md', sha256: 'abc', size: 3, updatedAt: '2026-11-04T00:00:00.000Z' }], skipped: [] }
  },
  presignWorkspaceRoot: async (workspaceId: string, files: Array<{ path: string; action: string }>) => {
    presignCalls.push(workspaceId)
    return {
      urls: files.map((file) => ({ path: file.path, action: file.action, url: `https://signed/${file.path}` })),
      skipped: ['node_modules/thing.js'],
    }
  },
}))

const { workspaceRootRoutes } = await import('../workspace-root')

function app(userId: string | null) {
  return workspaceRootRoutes({ resolveUserId: async () => userId })
}

beforeEach(() => {
  access = { [PERSONAL]: true, [TEAM]: true, 'ws-stranger': false }
  kinds = { [PERSONAL]: 'personal', [TEAM]: 'team' }
  manifestCalls = []
  presignCalls = []
  manifestShouldThrow = false
})

describe('GET /workspaces/:id/root/manifest', () => {
  test('a member of a Personal gets the manifest', async () => {
    const res = await app(MEMBER).request(`/workspaces/${PERSONAL}/root/manifest`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.files[0].path).toBe('MEMORY.md')
    expect(manifestCalls).toEqual([PERSONAL])
  })

  test('signed out is 401 and never touches the store', async () => {
    const res = await app(null).request(`/workspaces/${PERSONAL}/root/manifest`)
    expect(res.status).toBe(401)
    expect(manifestCalls).toEqual([])
  })

  test('a non-member is 403 and never touches the store', async () => {
    const res = await app('user-stranger').request(`/workspaces/${PERSONAL}/root/manifest`)
    expect(res.status).toBe(403)
    expect(manifestCalls).toEqual([])
  })

  test('a team workspace is refused: only the Personal has a shared root', async () => {
    const res = await app(MEMBER).request(`/workspaces/${TEAM}/root/manifest`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('not_personal')
    expect(manifestCalls).toEqual([])
  })

  test('a store failure is 502, not an empty manifest that reads as "nothing there"', async () => {
    manifestShouldThrow = true
    const res = await app(MEMBER).request(`/workspaces/${PERSONAL}/root/manifest`)
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).error.code).toBe('root_manifest_failed')
  })
})

describe('POST /workspaces/:id/root/presign', () => {
  const body = { files: [{ path: 'MEMORY.md', action: 'write' }] }

  test('a member of a Personal gets signed urls plus what was skipped', async () => {
    const res = await app(MEMBER).request(`/workspaces/${PERSONAL}/root/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.urls[0].url).toContain('MEMORY.md')
    expect(payload.skipped).toEqual(['node_modules/thing.js'])
    expect(presignCalls).toEqual([PERSONAL])
  })

  test('signed out is 401 and signs nothing', async () => {
    const res = await app(null).request(`/workspaces/${PERSONAL}/root/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(401)
    expect(presignCalls).toEqual([])
  })

  test('a non-member is 403 and signs nothing', async () => {
    const res = await app('user-stranger').request(`/workspaces/${PERSONAL}/root/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(403)
    expect(presignCalls).toEqual([])
  })

  test('a team workspace is refused', async () => {
    const res = await app(MEMBER).request(`/workspaces/${TEAM}/root/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('not_personal')
    expect(presignCalls).toEqual([])
  })

  test('a file without an action is rejected before anything is signed', async () => {
    const res = await app(MEMBER).request(`/workspaces/${PERSONAL}/root/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'MEMORY.md' }] }),
    })
    expect(res.status).toBe(400)
    expect(presignCalls).toEqual([])
  })

  test('more than 200 files in one call is rejected', async () => {
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, action: 'write' }))
    const res = await app(MEMBER).request(`/workspaces/${PERSONAL}/root/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('too_many_files')
    expect(presignCalls).toEqual([])
  })
})
