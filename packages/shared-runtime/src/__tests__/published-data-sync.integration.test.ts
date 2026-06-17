// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the published-data durability seam — the mechanism that
 * lets SERVER-BACKED published apps keep end-user writes across pod restarts /
 * scale-to-zero.
 *
 *   bun test packages/shared-runtime/src/__tests__/published-data-sync.integration.test.ts
 *
 * Unlike the unit test (mocked client), this exercises the REAL stack:
 *   - the real `@aws-sdk/client-s3` S3Client (request signing, retries),
 *   - real `tar` gzip create/extract,
 *   - a real HTTP roundtrip
 * against a minimal in-process S3-compatible server (path-style GET/PUT/HEAD).
 * No Docker / MinIO required — the server runs in the test process.
 *
 * The headline assertion mirrors the production promise: a write made by one
 * "pod" (PublishedDataSync instance) is restored byte-for-byte by a FRESH
 * instance pointed at the same bucket/subdomain — i.e. data survives the pod
 * going away (scale-to-zero) and a new one cold-starting.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PublishedDataSync } from '../published-data-sync'

// ─── In-process S3-compatible object store ───────────────────────────────────
// Handles exactly what PublishedDataSync needs: path-style PUT / GET / HEAD on
// `/{bucket}/{key}`. Auth headers are ignored. 404s for GET are returned as the
// S3 `NoSuchKey` XML error so the SDK maps them the way real S3 does.

interface StoredObject {
  body: Buffer
  contentType: string | null
}

let server: ReturnType<typeof Bun.serve> | null = null
let store: Map<string, StoredObject> = new Map()
let putCount = 0
let endpoint = ''

// Snapshot env we mutate so other suites are unaffected.
const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_REGION',
  'AWS_REQUEST_CHECKSUM_CALCULATION',
  'AWS_RESPONSE_CHECKSUM_VALIDATION',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

  process.env.AWS_ACCESS_KEY_ID = 'test'
  process.env.AWS_SECRET_ACCESS_KEY = 'test'
  process.env.S3_REGION = 'us-east-1'
  // Keep PutObject bodies as raw bytes (no aws-chunked trailer framing) so the
  // bytes we store == the bytes the SDK sent. Without this the v3 SDK may wrap
  // the upload in `aws-chunked` content-encoding and our naive server would
  // persist the framing too.
  process.env.AWS_REQUEST_CHECKSUM_CALCULATION = 'WHEN_REQUIRED'
  process.env.AWS_RESPONSE_CHECKSUM_VALIDATION = 'WHEN_REQUIRED'

  server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      const url = new URL(req.url)
      // Path-style: /{bucket}/{key...} — strip the leading bucket segment so
      // `store` is keyed by the object key alone (e.g. `{subdomain}/...`).
      const segments = decodeURIComponent(url.pathname.replace(/^\//, '')).split('/')
      segments.shift() // drop bucket
      const key = segments.join('/')

      if (req.method === 'PUT') {
        const body = Buffer.from(await req.arrayBuffer())
        store.set(key, { body, contentType: req.headers.get('content-type') })
        putCount++
        return new Response(null, { status: 200, headers: { ETag: '"test-etag"' } })
      }

      if (req.method === 'HEAD') {
        const obj = store.get(key)
        if (!obj) return new Response(null, { status: 404 })
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(obj.body.length) },
        })
      }

      if (req.method === 'GET') {
        const obj = store.get(key)
        if (!obj) {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`,
            { status: 404, headers: { 'content-type': 'application/xml' } },
          )
        }
        return new Response(new Uint8Array(obj.body), {
          status: 200,
          headers: { 'content-type': obj.contentType ?? 'application/octet-stream' },
        })
      }

      return new Response('method not allowed', { status: 405 })
    },
  })
  endpoint = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop(true)
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

beforeEach(() => {
  store = new Map()
  putCount = 0
})

// Per-test workspace dirs (cleaned in afterEach).
const createdDirs: string[] = []
function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pubdata-int-'))
  createdDirs.push(dir)
  return dir
}
afterEach(() => {
  while (createdDirs.length) {
    const d = createdDirs.pop()!
    rmSync(d, { recursive: true, force: true })
  }
})

function makeSync(localDir: string): PublishedDataSync {
  return new PublishedDataSync({
    bucket: 'shogo-published-data-test',
    prefix: 'august-29th-celebration-portal',
    localDir,
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    // Disable the periodic interval / watcher; tests drive flush() explicitly.
    syncInterval: 0,
    watchEnabled: false,
  })
}

describe('PublishedDataSync (real S3 SDK over in-process object store)', () => {
  test('restore() on an empty bucket returns false (first boot uses source seed)', async () => {
    const dir = freshWorkspace()
    const sync = makeSync(dir)
    expect(await sync.restore()).toBe(false)
  })

  test('flush() uploads the writable state as a real gzip tar', async () => {
    const dir = freshWorkspace()
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    writeFileSync(join(dir, 'prisma', 'dev.db'), 'GUESTLIST-V1')

    const sync = makeSync(dir)
    expect(await sync.flush()).toBe(true)

    // The object landed under `{subdomain}/data.tar.gz` and is a gzip stream.
    const stored = store.get('august-29th-celebration-portal/data.tar.gz')
    expect(stored).toBeDefined()
    expect(stored!.contentType).toBe('application/gzip')
    // gzip magic bytes.
    expect(stored!.body[0]).toBe(0x1f)
    expect(stored!.body[1]).toBe(0x8b)
  })

  test('end-to-end: a write by one pod survives scale-to-zero and is restored by a fresh pod', async () => {
    // ── Pod A: app writes a guest into its SQLite DB, then the pod flushes. ──
    const dirA = freshWorkspace()
    mkdirSync(join(dirA, 'prisma'), { recursive: true })
    writeFileSync(join(dirA, 'prisma', 'dev.db'), 'McCailey,Ada,Grace')
    // Also persist an uploads dir to prove non-DB writable paths roundtrip.
    mkdirSync(join(dirA, 'uploads'), { recursive: true })
    writeFileSync(join(dirA, 'uploads', 'seating.json'), '{"table":7}')

    const podA = makeSync(dirA)
    expect(await podA.flush()).toBe(true)
    await podA.flushAndShutdown(2000) // pod A goes away (scale-to-zero)

    // ── Pod B: brand-new empty workspace cold-starts and restores. ──
    const dirB = freshWorkspace()
    const podB = makeSync(dirB)
    expect(await podB.restore()).toBe(true)

    // The guest list + uploads materialized byte-for-byte on the new pod.
    expect(existsSync(join(dirB, 'prisma', 'dev.db'))).toBe(true)
    expect(readFileSync(join(dirB, 'prisma', 'dev.db'), 'utf-8')).toBe('McCailey,Ada,Grace')
    expect(readFileSync(join(dirB, 'uploads', 'seating.json'), 'utf-8')).toBe('{"table":7}')
  })

  test('a later write by pod B is visible to a subsequent pod C (writes accumulate)', async () => {
    // Pod A seeds.
    const dirA = freshWorkspace()
    mkdirSync(join(dirA, 'prisma'), { recursive: true })
    writeFileSync(join(dirA, 'prisma', 'dev.db'), 'row1')
    const podA = makeSync(dirA)
    await podA.flush()

    // Pod B restores, appends a new write, flushes.
    const dirB = freshWorkspace()
    const podB = makeSync(dirB)
    await podB.restore()
    writeFileSync(join(dirB, 'prisma', 'dev.db'), 'row1\nrow2')
    expect(await podB.flush()).toBe(true)

    // Pod C sees BOTH writes.
    const dirC = freshWorkspace()
    const podC = makeSync(dirC)
    expect(await podC.restore()).toBe(true)
    expect(readFileSync(join(dirC, 'prisma', 'dev.db'), 'utf-8')).toBe('row1\nrow2')
  })

  test('flush() is hash-skipped when nothing changed (no redundant PUTs)', async () => {
    const dir = freshWorkspace()
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    writeFileSync(join(dir, 'prisma', 'dev.db'), 'stable')
    const sync = makeSync(dir)

    expect(await sync.flush()).toBe(true)
    const afterFirst = putCount
    // Nothing changed on disk → second flush must NOT re-upload.
    expect(await sync.flush()).toBe(false)
    expect(putCount).toBe(afterFirst)

    // A real change re-uploads.
    writeFileSync(join(dir, 'prisma', 'dev.db'), 'changed')
    expect(await sync.flush()).toBe(true)
    expect(putCount).toBe(afterFirst + 1)
  })
})
