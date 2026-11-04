// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * The workspace root is the one thing a Personal workspace shares with the
 * cloud, so the failure modes here are the expensive ones: a memory file
 * uploaded twice a second, a log directory synced forever, or a conflict that
 * silently overwrites somebody's notes. These tests pin the three rules the
 * module promises — skip list agreement, metadata-carrying presigns, and a
 * conflict name that never lands on the winner.
 */

interface ListedObject {
  key: string
  relativePath: string
  size: number
  lastModified?: Date
  etag?: string
}

let listed: ListedObject[] = []
let heads: Record<string, { size: number; etag?: string; lastModified?: Date; metadata: Record<string, string> }> = {}
let listCalls: string[] = []
let headCalls: string[] = []
let presignWriteCalls: Array<{ key: string; options: any }> = []
let presignReadCalls: string[] = []

mock.module('../s3', () => ({
  buildWorkspaceRootKey: (workspaceId: string, filePath: string) =>
    `workspace-root/${workspaceId}/${filePath.replace(/^\/+/, '')}`,
  buildWorkspaceRootPrefix: (workspaceId: string) => `workspace-root/${workspaceId}/`,
  listAllObjectsInS3: async (prefix: string) => {
    listCalls.push(prefix)
    return listed
  },
  headS3Object: async (key: string) => {
    headCalls.push(key)
    return heads[key] ?? null
  },
  getPresignedWriteUrl: async (key: string, options: any) => {
    presignWriteCalls.push({ key, options })
    return `https://signed/write/${key}`
  },
  getPresignedReadUrl: async (key: string) => {
    presignReadCalls.push(key)
    return `https://signed/read/${key}`
  },
}))

const root = await import('../workspace-root-files')

beforeEach(() => {
  listed = []
  heads = {}
  listCalls = []
  headCalls = []
  presignWriteCalls = []
  presignReadCalls = []
})

describe('isSharedRootPath', () => {
  it('keeps the files that are the point of the root', () => {
    for (const path of ['AGENTS.md', 'MEMORY.md', 'memory/2026-11-04.md', 'skills/deploy/SKILL.md', 'config.json']) {
      expect(root.isSharedRootPath(path)).toBe(true)
    }
  })

  it('refuses build output, scratch space and local databases', () => {
    for (const path of [
      'node_modules/hono/index.js',
      '.git/config',
      'dist/index.js',
      '.next/cache/a.bin',
      'coverage/lcov.info',
      '.cache/x',
      '.vite/deps/x.js',
      '.turbo/state',
      'tmp/scratch.txt',
      '.tmp/notes.md',
      '.shogo/logs/build.log',
      '.shogo/tasks/t1.json',
      'prisma/dev.db',
      'prisma/dev.db-wal',
      '.memory-index.db',
      'shogo-local.db',
    ]) {
      expect(root.isSharedRootPath(path)).toBe(false)
    }
  })

  it('treats a leading slash and an empty path differently', () => {
    expect(root.isSharedRootPath('/MEMORY.md')).toBe(true)
    expect(root.isSharedRootPath('')).toBe(false)
    expect(root.isSharedRootPath('/')).toBe(false)
  })

  it('agrees with what the manifest hides — a conflict copy is a real file', () => {
    expect(root.isSharedRootPath('MEMORY.conflict-macbook-20261104T023000.md')).toBe(true)
  })
})

describe('readWorkspaceRootManifest', () => {
  it('drops objects the shared root does not own', async () => {
    listed = [
      { key: 'workspace-root/ws-1/AGENTS.md', relativePath: 'AGENTS.md', size: 10, etag: '"a"' },
      { key: 'workspace-root/ws-1/.shogo/logs/build.log', relativePath: '.shogo/logs/build.log', size: 99 },
      { key: 'workspace-root/ws-1/memory/', relativePath: 'memory/', size: 0 },
    ]

    const manifest = await root.readWorkspaceRootManifest('ws-1')

    expect(manifest.workspaceId).toBe('ws-1')
    expect(manifest.files.map((f) => f.path)).toEqual(['AGENTS.md'])
    expect(manifest.empty).toBe(false)
    expect(listCalls).toEqual(['workspace-root/ws-1/'])
  })

  it('reports an empty store rather than inventing entries', async () => {
    const manifest = await root.readWorkspaceRootManifest('ws-empty')
    expect(manifest).toEqual({ workspaceId: 'ws-empty', files: [], empty: true })
  })

  it('carries the etag and the writer metadata from the object itself', async () => {
    listed = [
      {
        key: 'workspace-root/ws-1/MEMORY.md',
        relativePath: 'MEMORY.md',
        size: 42,
        lastModified: new Date('2026-11-04T02:30:00.000Z'),
        etag: 'sha-of-bytes',
      },
    ]
    heads['workspace-root/ws-1/MEMORY.md'] = {
      size: 42,
      metadata: { sha256: 'declared-sha', instance: 'inst-macbook' },
    }

    const [entry] = (await root.readWorkspaceRootManifest('ws-1')).files

    expect(entry).toMatchObject({
      path: 'MEMORY.md',
      etag: 'sha-of-bytes',
      size: 42,
      updatedAt: '2026-11-04T02:30:00.000Z',
      sha256: 'declared-sha',
      updatedByInstanceId: 'inst-macbook',
    })
  })

  it('skips the metadata HEAD for objects that did not change since the last pull', async () => {
    listed = [
      {
        key: 'workspace-root/ws-1/AGENTS.md',
        relativePath: 'AGENTS.md',
        size: 1,
        lastModified: new Date('2026-11-01T00:00:00.000Z'),
        etag: 'old',
      },
      {
        key: 'workspace-root/ws-1/MEMORY.md',
        relativePath: 'MEMORY.md',
        size: 2,
        lastModified: new Date('2026-11-04T00:00:00.000Z'),
        etag: 'new',
      },
    ]
    heads['workspace-root/ws-1/MEMORY.md'] = { size: 2, metadata: { sha256: 's' } }

    const files = (await root.readWorkspaceRootManifest('ws-1', { since: new Date('2026-11-03T00:00:00.000Z') }))
      .files

    expect(headCalls).toEqual(['workspace-root/ws-1/MEMORY.md'])
    expect(files.find((f) => f.path === 'AGENTS.md')?.sha256).toBeNull()
    expect(files.find((f) => f.path === 'MEMORY.md')?.sha256).toBe('s')
  })

  it('still lists a file whose metadata HEAD failed', async () => {
    listed = [{ key: 'workspace-root/ws-1/MEMORY.md', relativePath: 'MEMORY.md', size: 2, etag: 'e' }]

    const files = (await root.readWorkspaceRootManifest('ws-1')).files

    expect(files).toHaveLength(1)
    expect(files[0].sha256).toBeNull()
  })
})

describe('presignWorkspaceRoot', () => {
  it('signs reads and writes with the writer recorded in the object metadata', async () => {
    const out = await root.presignWorkspaceRoot('ws-1', [
      { path: 'MEMORY.md', action: 'write', sha256: 'abc', instanceId: 'inst-win', contentType: 'text/markdown' },
      { path: 'AGENTS.md', action: 'read' },
    ])

    expect(out.skipped).toEqual([])
    expect(presignWriteCalls).toEqual([
      {
        key: 'workspace-root/ws-1/MEMORY.md',
        options: { contentType: 'text/markdown', metadata: { sha256: 'abc', instance: 'inst-win' } },
      },
    ])
    expect(presignReadCalls).toEqual(['workspace-root/ws-1/AGENTS.md'])
    expect(out.urls.map((u) => u.action)).toEqual(['write', 'read'])
  })

  it('reports skipped paths instead of signing an upload nobody will pull', async () => {
    const out = await root.presignWorkspaceRoot('ws-1', [
      { path: '.shogo/logs/build.log', action: 'write' },
      { path: 'node_modules/x/y.js', action: 'write' },
      { path: 'MEMORY.md', action: 'write' },
    ])

    expect(out.skipped).toEqual(['.shogo/logs/build.log', 'node_modules/x/y.js'])
    expect(presignWriteCalls).toHaveLength(1)
  })
})

describe('conflictPathFor', () => {
  it('keeps the loser beside the winner, still readable as the same kind of file', () => {
    const at = new Date('2026-11-04T02:30:00.000Z')
    expect(root.conflictPathFor('MEMORY.md', 'russells-macbook', at)).toBe(
      'MEMORY.conflict-russells-macbook-20261104T023000.md',
    )
    expect(root.conflictPathFor('memory/2026-11-04.md', 'Win Box', at)).toBe(
      'memory/2026-11-04.conflict-Win-Box-20261104T023000.md',
    )
  })

  it('never collides with the file it failed to overwrite', () => {
    const at = new Date('2026-11-04T02:30:00.000Z')
    for (const path of ['MEMORY.md', 'AGENTS.md', 'skills/deploy/SKILL.md', 'README']) {
      expect(root.conflictPathFor(path, 'mac', at)).not.toBe(path)
    }
  })

  it('falls back to a usable device segment when the name has nothing left', () => {
    expect(root.conflictPathFor('MEMORY.md', '///', new Date('2026-11-04T02:30:00.000Z'))).toBe(
      'MEMORY.conflict-device-20261104T023000.md',
    )
  })
})

describe('conflictCopiesOf', () => {
  it('finds copies a device has not reconciled yet', () => {
    const manifest = {
      workspaceId: 'ws-1',
      empty: false,
      files: [
        { path: 'MEMORY.md', etag: null, size: 1, updatedAt: null, sha256: null, updatedByInstanceId: null },
        {
          path: 'MEMORY.conflict-mac-20261104T023000.md',
          etag: null,
          size: 1,
          updatedAt: null,
          sha256: null,
          updatedByInstanceId: null,
        },
      ],
    }
    expect(root.conflictCopiesOf(manifest).map((f) => f.path)).toEqual([
      'MEMORY.conflict-mac-20261104T023000.md',
    ])
  })
})
