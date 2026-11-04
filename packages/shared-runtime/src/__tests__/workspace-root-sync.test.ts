// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  conflictPathFor,
  createWorkspaceRootSync,
  isSharedRootPath,
  sha256Of,
  type WorkspaceRootManifest,
  type WorkspaceRootPresignRequest,
  type WorkspaceRootTransport,
} from '../workspace-root-sync'

/**
 * These are the two assertions QA named as the ones that actually fail when the
 * store and the sync are wired wrong: a file written on one machine reading
 * back on another, and two machines editing the same file without either line
 * being lost.
 */

interface StoredObject {
  bytes: Uint8Array
  etag: string
  metadata: Record<string, string>
}

/** An in-memory stand-in for the S3 prefix plus the two API routes. */
function createStore() {
  const objects = new Map<string, StoredObject>()
  const writes: Array<{ path: string; metadata: Record<string, string> }> = []

  const transport: WorkspaceRootTransport = {
    async manifest(): Promise<WorkspaceRootManifest> {
      const files = [...objects.entries()].map(([path, object]) => ({
        path,
        etag: object.etag,
        size: object.bytes.byteLength,
        updatedAt: null,
        sha256: object.metadata.sha256 ?? null,
        updatedByInstanceId: object.metadata.instance ?? null,
      }))
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { workspaceId: 'ws-1', files, empty: files.length === 0 }
    },
    async presign(files: WorkspaceRootPresignRequest[]) {
      const urls = files.map((file) => ({
        path: file.path,
        action: file.action,
        url: `mem://${file.action}/${encodeURIComponent(file.path)}`,
      }))
      // The write URL carries the metadata the API would have signed into it.
      const pending = files.filter((f) => f.action === 'write')
      for (const file of pending) {
        const url = urls.find((u) => u.path === file.path && u.action === 'write')!
        url.url += `?sha=${file.sha256 ?? ''}&instance=${file.instanceId ?? ''}`
      }
      return { urls, skipped: [] }
    },
  }

  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (url.host === 'read') {
      const object = objects.get(path)
      if (!object) return new Response('not found', { status: 404 })
      return new Response(object.bytes as unknown as BodyInit, { status: 200 })
    }
    if (url.host === 'write') {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer())
      objects.set(path, {
        bytes,
        etag: `etag-${sha256Of(bytes).slice(0, 12)}`,
        metadata: {
          sha256: url.searchParams.get('sha') || '',
          instance: url.searchParams.get('instance') || '',
        },
      })
      writes.push({ path, metadata: objects.get(path)!.metadata })
      return new Response('', { status: 200 })
    }
    return new Response('bad url', { status: 400 })
  }) as unknown as typeof fetch

  return { objects, writes, transport, fetchImpl }
}

let tmp: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-root-'))
  tmp.push(dir)
  return dir
}

function write(dir: string, filePath: string, contents: string): void {
  const full = join(dir, filePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
}

function read(dir: string, filePath: string): string {
  return readFileSync(join(dir, filePath), 'utf-8')
}

beforeEach(() => {
  tmp = []
})

afterEach(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true })
})

describe('isSharedRootPath', () => {
  it('shares the files that make a root a root', () => {
    for (const path of ['AGENTS.md', 'MEMORY.md', 'memory/2026-11-04.md', 'skills/deploy/SKILL.md']) {
      expect(isSharedRootPath(path)).toBe(true)
    }
  })

  it('leaves build output, logs, scratch space and local databases alone', () => {
    for (const path of [
      'node_modules/hono/index.js',
      '.git/config',
      'dist/out.js',
      '.shogo/logs/build.log',
      '.tmp/scratch.md',
      'prisma/dev.db',
      '.memory-index.db',
      '.shogo/workspace-root-state.json',
    ]) {
      expect(isSharedRootPath(path)).toBe(false)
    }
  })

  /**
   * A manifest path is joined onto the root on every device that pulls it, so a
   * path that climbs out of the root is a write outside the workspace — signed
   * by the API, executed by every machine. QA found this one by presigning
   * `../../pwned.md`: it was signed, and the next pull wrote it above the root.
   */
  it('refuses a path that climbs out of the root, whichever way it is spelled', () => {
    for (const path of [
      '..',
      '../pwned.md',
      '../../pwned.md',
      'memory/../../pwned.md',
      'memory/./notes.md',
      'memory//notes.md',
      'C:/Windows/System32/drivers/etc/hosts',
      'c:\\Windows\\win.ini',
      '~/.ssh/authorized_keys',
    ]) {
      expect(isSharedRootPath(path)).toBe(false)
    }
  })
})

describe('createWorkspaceRootSync', () => {
  it('round-trips a file written on one machine to another', async () => {
    const store = createStore()
    const a = tempDir()
    const b = tempDir()

    write(a, 'MEMORY.md', '# Memory A\nprefers window seats\n')
    const syncA = createWorkspaceRootSync({
      dir: a,
      deviceName: 'macbook',
      transport: store.transport,
      fetchImpl: store.fetchImpl,
      instanceId: 'inst-a',
    })
    await syncA.sync()

    expect(store.objects.has('MEMORY.md')).toBe(true)
    expect(store.writes[0].metadata.instance).toBe('inst-a')
    expect(store.writes[0].metadata.sha256).toBe(sha256Of(readFileSync(join(a, 'MEMORY.md'))))

    const syncB = createWorkspaceRootSync({
      dir: b,
      deviceName: 'windows',
      transport: store.transport,
      fetchImpl: store.fetchImpl,
      instanceId: 'inst-b',
    })
    const stats = await syncB.sync()

    expect(stats.pulled).toBe(1)
    expect(read(b, 'MEMORY.md')).toBe('# Memory A\nprefers window seats\n')
  })

  it('keeps the loser of a conflict beside the cloud copy instead of overwriting it', async () => {
    const store = createStore()
    const a = tempDir()
    const b = tempDir()

    write(a, 'MEMORY.md', 'shared base\n')
    const syncA = createWorkspaceRootSync({ dir: a, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })
    const syncB = createWorkspaceRootSync({ dir: b, deviceName: 'windows', transport: store.transport, fetchImpl: store.fetchImpl })

    await syncA.sync()
    await syncB.sync()
    expect(read(b, 'MEMORY.md')).toBe('shared base\n')

    write(a, 'MEMORY.md', 'line written on the mac\n')
    await syncA.sync()

    write(b, 'MEMORY.md', 'line written on windows\n')
    const stats = await syncB.sync()

    // The cloud's version wins ...
    expect(read(b, 'MEMORY.md')).toBe('line written on the mac\n')
    // ... and windows' line survives next to it, still a Markdown file.
    const conflict = stats.conflicts[0]
    expect(conflict).toMatch(/^MEMORY\.conflict-windows-\d{8}T\d{6}\.md$/)
    expect(read(b, conflict)).toBe('line written on windows\n')
    // The conflict copy is itself shared, so the mac sees both lines next pull.
    expect(store.objects.has(conflict)).toBe(true)

    await syncA.sync()
    expect(read(a, conflict)).toBe('line written on windows\n')
    expect(read(a, 'MEMORY.md')).toBe('line written on the mac\n')
  })

  it('keeps a local file when the cloud copy was written before this device ever synced', async () => {
    // No state file at all: the device is syncing this root for the first time
    // (a fresh install, or `.shogo/workspace-root-state.json` was lost). There
    // is no baseline, so the cloud copy is not "newer" — it is just the other
    // side — and overwriting would delete the line this device wrote.
    const store = createStore()
    const other = tempDir()
    const device = tempDir()

    write(other, 'MEMORY.md', '# Memory\nline from the cloud\n')
    const syncOther = createWorkspaceRootSync({ dir: other, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })
    await syncOther.sync()
    expect(store.objects.has('MEMORY.md')).toBe(true)

    write(device, 'MEMORY.md', '# Memory\nline written here first\n')
    const syncDevice = createWorkspaceRootSync({ dir: device, deviceName: 'windows', transport: store.transport, fetchImpl: store.fetchImpl })
    const stats = await syncDevice.sync()

    // The cloud's copy is canonical ...
    expect(read(device, 'MEMORY.md')).toBe('# Memory\nline from the cloud\n')
    // ... and the line written here survives beside it.
    const conflict = stats.conflicts[0]
    expect(conflict).toMatch(/^MEMORY\.conflict-windows-\d{8}T\d{6}\.md$/)
    expect(read(device, conflict)).toBe('# Memory\nline written here first\n')
    expect(store.objects.has(conflict)).toBe(true)
  })

  it('treats an identical file with no state as the same file, not a conflict', async () => {
    const store = createStore()
    const a = tempDir()
    const b = tempDir()

    write(a, 'MEMORY.md', 'the same line\n')
    const syncA = createWorkspaceRootSync({ dir: a, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })
    await syncA.sync()

    // b already holds exactly those bytes and has never synced: nothing to keep.
    write(b, 'MEMORY.md', 'the same line\n')
    const syncB = createWorkspaceRootSync({ dir: b, deviceName: 'windows', transport: store.transport, fetchImpl: store.fetchImpl })
    const first = await syncB.sync()
    expect(first.conflicts).toEqual([])
    expect(read(b, 'MEMORY.md')).toBe('the same line\n')

    // ... and the state it recorded means the next pass sends nothing.
    const writesAfterFirst = store.writes.length
    const second = await syncB.sync()
    expect(second.conflicts).toEqual([])
    expect(second.pushed).toBe(0)
    expect(store.writes.length).toBe(writesAfterFirst)
  })

  it('compares the stored bytes when the writer declared no sha', async () => {
    // A file uploaded before this module existed (or by anything that did not
    // declare a sha) has no `sha256` in the manifest, so "same file?" can only
    // be answered by reading it.
    const store = createStore()
    const device = tempDir()
    const cloudBytes = new TextEncoder().encode('cloud line\n')
    store.objects.set('MEMORY.md', { bytes: cloudBytes, etag: 'etag-cloud', metadata: { sha256: '', instance: '' } })

    write(device, 'MEMORY.md', 'local line\n')
    const sync = createWorkspaceRootSync({ dir: device, deviceName: 'windows', transport: store.transport, fetchImpl: store.fetchImpl })
    const stats = await sync.sync()

    expect(read(device, 'MEMORY.md')).toBe('cloud line\n')
    expect(stats.conflicts.length).toBe(1)
    expect(read(device, stats.conflicts[0])).toBe('local line\n')
  })

  it('never deletes: a file removed here is not removed there, and back', async () => {
    const store = createStore()
    const a = tempDir()

    write(a, 'MEMORY.md', 'one\n')
    write(a, 'notes/keep.txt', 'keep\n')
    const sync = createWorkspaceRootSync({ dir: a, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })
    await sync.sync()
    expect(store.objects.size).toBe(2)

    rmSync(join(a, 'notes/keep.txt'))
    await sync.sync()
    // Still in the store — a delete racing an edit is how a memory file dies.
    expect(store.objects.has('notes/keep.txt')).toBe(true)

    // And a file the store has but this machine lost comes back.
    rmSync(join(a, 'MEMORY.md'))
    await sync.sync()
    expect(read(a, 'MEMORY.md')).toBe('one\n')
  })

  it('sends nothing when neither side changed', async () => {
    const store = createStore()
    const dir = tempDir()
    write(dir, 'MEMORY.md', 'steady\n')
    const sync = createWorkspaceRootSync({ dir, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })

    await sync.sync()
    const writesAfterFirst = store.writes.length
    const second = await sync.sync()

    expect(second.pulled).toBe(0)
    expect(second.pushed).toBe(0)
    expect(store.writes.length).toBe(writesAfterFirst)
  })

  it('notices an unchanged-size edit through the stat walk', async () => {
    const store = createStore()
    const dir = tempDir()
    write(dir, 'MEMORY.md', 'aaaa\n')
    const sync = createWorkspaceRootSync({ dir, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })
    await sync.sync()

    expect(sync.hasLocalEdits()).toBe(false)
    write(dir, 'MEMORY.md', 'bbbb\n')
    expect(sync.hasLocalEdits()).toBe(true)

    await sync.sync()
    expect(store.writes.length).toBe(2)
  })

  /**
   * The scan loop only syncs when `hasLocalEdits()` says a file moved. QA caught
   * a pulled file being recorded with `Date.now()` while the walk compares
   * `statSync().mtimeMs` (fractional), so every device reported an edit forever
   * and re-listed the whole root every scan interval.
   */
  it('does not report an edit for a file it just pulled', async () => {
    const store = createStore()
    const a = tempDir()
    const b = tempDir()
    write(a, 'MEMORY.md', '# Memory A\n')
    const syncA = createWorkspaceRootSync({ dir: a, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })
    const syncB = createWorkspaceRootSync({ dir: b, deviceName: 'windows', transport: store.transport, fetchImpl: store.fetchImpl })
    await syncA.sync()

    const stats = await syncB.sync()
    expect(stats.pulled).toBe(1)
    expect(read(b, 'MEMORY.md')).toBe('# Memory A\n')
    expect(syncB.hasLocalEdits()).toBe(false)
  })

  it('writes nothing outside the root for a manifest entry that climbs out', async () => {
    const store = createStore()
    const parent = tempDir()
    const dir = join(parent, 'workspace')
    mkdirSync(dir, { recursive: true })
    // A store object nobody should be able to make the sync write to.
    store.objects.set('../pwned.md', { bytes: new TextEncoder().encode('PWNED'), etag: 'e1', metadata: {} })
    const sync = createWorkspaceRootSync({ dir, deviceName: 'macbook', transport: store.transport, fetchImpl: store.fetchImpl })

    const stats = await sync.sync()
    expect(stats.pulled).toBe(0)
    expect(existsSync(join(parent, 'pwned.md'))).toBe(false)
  })

  it('logs a failed transfer instead of throwing out of the sync', async () => {
    const dir = tempDir()
    write(dir, 'MEMORY.md', 'x\n')
    const sync = createWorkspaceRootSync({
      dir,
      deviceName: 'macbook',
      transport: {
        manifest: async () => ({ workspaceId: 'ws-1', files: [], empty: true }),
        presign: async () => {
          throw new Error('store down')
        },
      },
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    })

    const stats = await sync.sync()
    expect(stats.errors).toHaveLength(1)
    expect(stats.errors[0]).toContain('store down')
  })
})

describe('conflictPathFor', () => {
  it('stays beside the file and keeps its extension', () => {
    expect(conflictPathFor('memory/2026-11-04.md', 'Win Box', new Date('2026-11-04T02:30:00.000Z'))).toBe(
      'memory/2026-11-04.conflict-Win-Box-20261104T023000.md',
    )
  })
})
