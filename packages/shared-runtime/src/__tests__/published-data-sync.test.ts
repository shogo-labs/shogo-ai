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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
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
