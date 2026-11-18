// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the published-data sync — the writable-state durability seam
// for SERVER-BACKED published apps. It persists ONLY mutable runtime state
// (the SQLite DB + upload dirs) to `shogo-published-data-{env}/{subdomain}/`,
// separate from the read-only source archive.
//
// These tests avoid real network I/O by exercising the env-driven factory and
// the local-filesystem behaviors (restore no-op on a missing archive, flush
// no-op when there's nothing writable to archive) with the S3 client stubbed.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs'
import * as tar from 'tar'
import { tmpdir } from 'os'
import { join } from 'path'
import { PublishedDataSync, createPublishedDataSyncFromEnv } from '../published-data-sync'

const ENV_KEYS = [
  'S3_PUBLISHED_DATA_BUCKET',
  'PUBLISH_DATA_BUCKET',
  'PUBLISHED_SUBDOMAIN',
  'PUBLISHED_DATA_PATHS',
  'S3_REGION',
  'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'PUBLISHED_DATA_SYNC_INTERVAL',
  'PUBLISHED_DATA_WATCH',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('createPublishedDataSyncFromEnv', () => {
  test('returns null when the data bucket is unset', () => {
    process.env.PUBLISHED_SUBDOMAIN = 'my-app'
    expect(createPublishedDataSyncFromEnv('/tmp/x')).toBeNull()
  })

  test('returns null when the subdomain is unset', () => {
    process.env.S3_PUBLISHED_DATA_BUCKET = 'shogo-published-data-staging'
    expect(createPublishedDataSyncFromEnv('/tmp/x')).toBeNull()
  })

  test('returns an instance when bucket + subdomain are set', () => {
    process.env.S3_PUBLISHED_DATA_BUCKET = 'shogo-published-data-staging'
    process.env.PUBLISHED_SUBDOMAIN = 'august-29th-celebration-portal'
    const sync = createPublishedDataSyncFromEnv('/tmp/x')
    expect(sync).not.toBeNull()
  })

  test('PUBLISH_DATA_BUCKET is accepted as a fallback bucket name', () => {
    process.env.PUBLISH_DATA_BUCKET = 'shogo-published-data-production'
    process.env.PUBLISHED_SUBDOMAIN = 'my-app'
    expect(createPublishedDataSyncFromEnv('/tmp/x')).not.toBeNull()
  })
})

describe('PublishedDataSync archive layout', () => {
  test('archive key is {subdomain}/data.tar.gz', () => {
    const sync = new PublishedDataSync({
      bucket: 'shogo-published-data-staging',
      prefix: 'my-app',
      localDir: '/tmp/x',
    }) as any
    expect(sync.archiveKey).toBe('my-app/data.tar.gz')
  })

  test('existingPaths only returns writable paths that exist on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubdata-test-'))
    try {
      mkdirSync(join(dir, 'prisma'), { recursive: true })
      writeFileSync(join(dir, 'prisma', 'dev.db'), 'sqlite')
      const sync = new PublishedDataSync({
        bucket: 'b',
        prefix: 'p',
        localDir: dir,
      }) as any
      const paths = sync.existingPaths() as string[]
      expect(paths).toContain('prisma/dev.db')
      // Upload dirs that don't exist must NOT be listed.
      expect(paths).not.toContain('uploads')
      expect(paths).not.toContain('public/uploads')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PublishedDataSync.flush', () => {
  test('no-ops (returns false) when there is no writable state on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubdata-empty-'))
    try {
      const sync = new PublishedDataSync({ bucket: 'b', prefix: 'p', localDir: dir })
      // No prisma/dev.db, no upload dirs → nothing to archive, no S3 call.
      const uploaded = await sync.flush()
      expect(uploaded).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PublishedDataSync.restore', () => {
  test('returns false (not an error) when the archive does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubdata-restore-'))
    try {
      const sync = new PublishedDataSync({ bucket: 'b', prefix: 'p', localDir: dir }) as any
      // Stub the S3 client to simulate a missing object (NoSuchKey).
      sync.client = {
        send: async () => {
          const err: any = new Error('not found')
          err.name = 'NoSuchKey'
          throw err
        },
      }
      const restored = await sync.restore()
      expect(restored).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PublishedDataSync.restoreSource', () => {
  /** A stub client serving `objects` by key; anything else is NoSuchKey. */
  function stubClient(objects: Record<string, Buffer>, seen: string[]) {
    return {
      send: async (cmd: any) => {
        const key = cmd.input.Key as string
        seen.push(key)
        const body = objects[key]
        if (!body) {
          const err: any = new Error('not found')
          err.name = 'NoSuchKey'
          throw err
        }
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } }
      },
    }
  }

  async function tarOf(files: Record<string, string>): Promise<Buffer> {
    const src = mkdtempSync(join(tmpdir(), 'pubsrc-src-'))
    try {
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(src, rel, '..'), { recursive: true })
        writeFileSync(join(src, rel), content)
      }
      const out = join(src, '..', `${Math.random().toString(36).slice(2)}.tar.gz`)
      await tar.create({ gzip: true, file: out, cwd: src, portable: true }, Object.keys(files))
      const buf = readFileSync(out)
      rmSync(out, { force: true })
      return buf
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  }

  test('extracts the publish-pinned source from {subdomain}/source.tar.gz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubsrc-'))
    try {
      writeFileSync(join(dir, 'server.tsx'), 'stale\n')
      const seen: string[] = []
      const sync = new PublishedDataSync({ bucket: 'b', prefix: 'kif-crm', localDir: dir }) as any
      sync.client = stubClient(
        { 'kif-crm/source.tar.gz': await tarOf({ 'server.tsx': 'fresh\n', 'auth-routes.ts': 'x\n' }) },
        seen,
      )
      expect(await sync.restoreSource()).toBe(true)
      expect(seen).toEqual(['kif-crm/source.tar.gz'])
      expect(readFileSync(join(dir, 'server.tsx'), 'utf8')).toBe('fresh\n')
      expect(readFileSync(join(dir, 'auth-routes.ts'), 'utf8')).toBe('x\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns false when nothing was pinned, so boot falls back to the durable backups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubsrc-missing-'))
    try {
      const sync = new PublishedDataSync({ bucket: 'b', prefix: 'kif-crm', localDir: dir }) as any
      sync.client = stubClient({}, [])
      expect(await sync.restoreSource()).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the writable-state restore still reads data.tar.gz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pubsrc-data-'))
    try {
      const seen: string[] = []
      const sync = new PublishedDataSync({ bucket: 'b', prefix: 'kif-crm', localDir: dir }) as any
      sync.client = stubClient({ 'kif-crm/data.tar.gz': await tarOf({ 'prisma/dev.db': 'db' }) }, seen)
      expect(await sync.restore()).toBe(true)
      expect(seen).toEqual(['kif-crm/data.tar.gz'])
      expect(readFileSync(join(dir, 'prisma/dev.db'), 'utf8')).toBe('db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
