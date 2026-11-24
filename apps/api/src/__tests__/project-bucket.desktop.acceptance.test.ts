// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-491 acceptance — the DESKTOP (filesystem) bucket, end to end over HTTP.
 *
 * The existing unit suites mock either the service or the driver, so nothing
 * joined the real routes to the real filesystem backend and then to the real
 * SDK client. This test does: it serves `projectBucketRoutes()` +
 * `projectBucketPublicRoutes()` from a real `Bun.serve`, points the published
 * `BucketClient` at it (exactly how an app route uses `shogo.bucket`), and
 * checks the acceptance criteria that are observable on desktop:
 *
 *   AC2  a private object is not readable through the public route, and is
 *        readable through `signedUrl`
 *   AC5  the same SDK calls work against the filesystem backend, and the URL
 *        `b.url(key)` returns serves the bytes with `Range` and CORS
 *   AC6  `purgeProjectBucket` removes the bytes and the rows
 *
 * Runs isolated (it mocks `../lib/prisma`, like the other bucket suites).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

// ─── in-memory index (stands in for prisma) ───────────────────────────────────

interface Row {
  id: string
  projectId: string
  key: string
  visibility: string
  size: bigint
  contentType: string | null
  etag: string | null
  sha256: string | null
  createdAt: Date
  updatedAt: Date
}

const rows = new Map<string, Row>()
const rowId = (projectId: string, visibility: string, key: string) => `${projectId}|${visibility}|${key}`

function matches(row: Row, where: any): boolean {
  if (!where) return true
  if (where.projectId && row.projectId !== where.projectId) return false
  if (where.visibility && row.visibility !== where.visibility) return false
  if (where.key) {
    if (typeof where.key === 'string' && row.key !== where.key) return false
    if (where.key.startsWith !== undefined && !row.key.startsWith(where.key.startsWith)) return false
    if (where.key.gt !== undefined && !(row.key > where.key.gt)) return false
  }
  return true
}

const prismaStub = {
  projectBucketObject: {
    async findUnique({ where }: any) {
      return rows.get(rowId(where.projectId_visibility_key.projectId, where.projectId_visibility_key.visibility, where.projectId_visibility_key.key)) ?? null
    },
    async upsert({ where, create, update }: any) {
      const id = rowId(where.projectId_visibility_key.projectId, where.projectId_visibility_key.visibility, where.projectId_visibility_key.key)
      const existing = rows.get(id)
      const row: Row = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : {
            id,
            projectId: create.projectId,
            key: create.key,
            visibility: create.visibility,
            size: create.size,
            contentType: create.contentType ?? null,
            etag: create.etag ?? null,
            sha256: create.sha256 ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
      rows.set(id, row)
      return row
    },
    async update({ where, data }: any) {
      const id = rowId(where.projectId_visibility_key.projectId, where.projectId_visibility_key.visibility, where.projectId_visibility_key.key)
      const row = rows.get(id)!
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
    async findMany({ where, take }: any) {
      const found = [...rows.values()].filter((row) => matches(row, where)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      return take ? found.slice(0, take) : found
    },
    async delete({ where }: any) {
      const id = rowId(where.projectId_visibility_key.projectId, where.projectId_visibility_key.visibility, where.projectId_visibility_key.key)
      const row = rows.get(id)!
      rows.delete(id)
      return row
    },
    async deleteMany({ where }: any) {
      for (const [id, row] of [...rows.entries()]) if (matches(row, where)) rows.delete(id)
      return { count: 1 }
    },
    async aggregate({ where, _sum, _count }: any) {
      const found = [...rows.values()].filter((row) => matches(row, where))
      const result: any = {}
      if (_sum) result._sum = { size: found.reduce((total, row) => total + Number(row.size), 0) }
      if (_count) result._count = { _all: found.length }
      return result
    },
  },
  workspace: {
    async findUnique() {
      return { instanceSize: 'micro' }
    },
  },
  storageUsage: {
    async findUnique() {
      return null
    },
  },
  project: {
    async findUnique({ where }: any) {
      return where.id === PROJECT_ID ? { id: PROJECT_ID, workspaceId: 'ws-qa' } : null
    },
    async findMany() {
      return [{ id: PROJECT_ID }]
    },
  },
}

const PROJECT_ID = 'proj-qa-491'

const { mock } = await import('bun:test')
mock.module('../lib/prisma', () => ({ prisma: prismaStub }))

const service = await import('../services/project-bucket.service')
const { projectBucketRoutes, projectBucketPublicRoutes } = await import('../routes/project-bucket')
const { BucketClient } = await import('@shogo-ai/sdk/bucket')

// ─── the real server ──────────────────────────────────────────────────────────

let bucketDir: string
let server: ReturnType<typeof Bun.serve>
let base: string
let client: InstanceType<typeof BucketClient>

beforeAll(async () => {
  bucketDir = await mkdtemp(join(tmpdir(), 'sho491-bucket-'))
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.PROJECT_BUCKET_DIR = bucketDir

  const app = new Hono()
  let mounted: Hono | null = null
  server = Bun.serve({
    port: 0,
    fetch: (request) => (mounted as Hono).fetch(request),
  })
  base = `http://localhost:${server.port}`
  process.env.SHOGO_PUBLIC_API_URL = base

  app.route('/api', projectBucketRoutes({ apiOrigin: base }))
  app.route('/', projectBucketPublicRoutes())
  mounted = app

  client = new BucketClient({ apiUrl: base, projectId: PROJECT_ID, runtimeToken: 'rt-qa', fetch: fetch as any })
})

afterAll(async () => {
  server?.stop(true)
  await rm(bucketDir, { recursive: true, force: true })
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.PROJECT_BUCKET_DIR
  delete process.env.SHOGO_PUBLIC_API_URL
  rows.clear()
})

// ─── AC5: the SDK's own calls, over HTTP, against the filesystem backend ─────

describe('AC5 — desktop: put → url() → GET serves the bytes', () => {
  const body = new TextEncoder().encode('0123456789abcdef')

  test('put streams to the API and indexes the object', async () => {
    const stored = await client.put('media/clip.bin', body, { contentType: 'application/octet-stream' })
    expect(stored.key).toBe('media/clip.bin')
    expect(stored.size).toBe(body.byteLength)
    expect(stored.visibility).toBe('public')
    expect(stored.url).toBe(`${base}/api/bucket/${PROJECT_ID}/public/media/clip.bin`)
    expect(await stat(join(bucketDir, 'p', PROJECT_ID, 'public', 'media', 'clip.bin'))).toBeTruthy()
  })

  test('url() returns a URL that serves the object (this is what an app links)', async () => {
    const response = await fetch(client.url('media/clip.bin'))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('the public route answers Range with 206 and the right slice', async () => {
    const url = client.url('media/clip.bin')
    const response = await fetch(url, { headers: { Range: 'bytes=4-7' } })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('4567')
    expect(response.headers.get('content-range')).toBe(`bytes 4-7/${body.byteLength}`)
  })

  test('HEAD answers the size', async () => {
    const response = await fetch(client.url('media/clip.bin'), { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(body.byteLength))
  })

  test('a duplicate key is a 409 until overwrite is passed', async () => {
    await expect(client.put('media/clip.bin', body)).rejects.toMatchObject({ code: 'key_exists', status: 409 })
    const replaced = await client.put('media/clip.bin', new TextEncoder().encode('replaced'), { overwrite: true })
    expect(replaced.size).toBe(8)
    const response = await fetch(client.url('media/clip.bin'))
    expect(await response.text()).toBe('replaced')
    // restore the original for the range tests above re-running
    await client.put('media/clip.bin', body, { overwrite: true })
  })
})

describe('AC2 — desktop: a private object is not public', () => {
  test('private objects are refused on the public route and readable via signedUrl', async () => {
    const secret = new TextEncoder().encode('private-bytes')
    const stored = await client.put('exports/secret.txt', secret, { visibility: 'private' })
    expect(stored.url).toBeNull()

    const guessed = `${base}/api/bucket/${PROJECT_ID}/public/exports/secret.txt`
    expect((await fetch(guessed)).status).toBe(404)

    const signed = await client.signedUrl('exports/secret.txt', { public: false })
    const response = await fetch(signed)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('private-bytes')
  })

  test('an expired or forged token is refused', async () => {
    await client.put('exports/other.txt', new TextEncoder().encode('x'), { visibility: 'private' })
    const signed = await client.signedUrl('exports/other.txt', { public: false })
    const forged = signed.replace(/t=[^&]+/, 't=1.deadbeef')
    expect((await fetch(forged)).status).toBe(403)
  })
})

describe('key rules', () => {
  test('a traversal key is a 400 invalid_key', async () => {
    const response = await fetch(`${base}/api/projects/${PROJECT_ID}/bucket/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '../escape.bin', size: 1 }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_key')
  })
})

describe('AC6 — delete and purge', () => {
  test('deleting an object removes the bytes and the row', async () => {
    await client.put('tmp/gone.bin', new TextEncoder().encode('bye'))
    const url = client.url('tmp/gone.bin')
    await client.delete('tmp/gone.bin')
    expect((await fetch(url)).status).toBe(404)
    expect([...rows.values()].some((row) => row.key === 'tmp/gone.bin')).toBe(false)
  })

  test('purging the project empties the prefix and the index', async () => {
    await client.put('keep/a.bin', new TextEncoder().encode('a'))
    await client.put('keep/b.bin', new TextEncoder().encode('b'), { visibility: 'private' })
    const purged = await service.purgeProjectBucket(PROJECT_ID)
    expect(purged.empty).toBe(true)
    expect(rows.size).toBe(0)
    const listed = await service.listBucketObjects(PROJECT_ID)
    expect(listed.objects).toHaveLength(0)
  })
})
