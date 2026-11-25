// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Project bucket service (SHO-491).
 *
 * Two halves:
 *
 *  - the desktop (filesystem) driver, exercised for real against a temp
 *    `PROJECT_BUCKET_DIR` — upload ticket → PUT → complete → list → head →
 *    delete, including a Range read and a private-object signed URL;
 *  - the storage gate, which is what keeps a workspace from writing past its
 *    allowance for free: under the allowance always allowed, over it only when
 *    the wallet can pay, and never when billing is in `shadow`.
 *
 * Prisma and the billing module are mocked, so this suite is hermetic and never
 * touches a real bucket.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── prisma (in-memory index) ───────────────────────────────────────────────

interface Row {
  id: string
  projectId: string
  key: string
  visibility: string
  size: bigint
  contentType: string | null
  etag: string | null
  sha256: string | null
  updatedAt: Date
}

const rows = new Map<string, Row>()
const rowId = (projectId: string, visibility: string, key: string) => `${projectId}\u0000${visibility}\u0000${key}`

const findUnique = mock(async ({ where }: any): Promise<any> => {
  const id = where.projectId_visibility_key
  return rows.get(rowId(id.projectId, id.visibility, id.key)) ?? null
})

const upsert = mock(async ({ where, create, update }: any): Promise<any> => {
  const id = where.projectId_visibility_key
  const mapKey = rowId(id.projectId, id.visibility, id.key)
  const existing = rows.get(mapKey)
  const next: Row = existing
    ? { ...existing, ...update }
    : {
        id: `row_${rows.size + 1}`,
        projectId: create.projectId,
        key: create.key,
        visibility: create.visibility,
        size: create.size,
        contentType: create.contentType ?? null,
        etag: create.etag ?? null,
        sha256: null,
        updatedAt: new Date(),
      }
  rows.set(mapKey, next)
  return { size: next.size, etag: next.etag, sha256: next.sha256 }
})

const findMany = mock(async ({ where }: any): Promise<any[]> => {
  return Array.from(rows.values())
    .filter((row) => row.projectId === where.projectId)
    .filter((row) => (where.visibility ? row.visibility === where.visibility : true))
    .filter((row) => {
      const filter = where.key
      if (!filter) return true
      if (typeof filter.startsWith === 'string' && !row.key.startsWith(filter.startsWith)) return false
      if (typeof filter.gt === 'string' && !(row.key > filter.gt)) return false
      return true
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
})

const deleteRow = mock(async ({ where }: any): Promise<any> => {
  const id = where.projectId_visibility_key
  const mapKey = rowId(id.projectId, id.visibility, id.key)
  const row = rows.get(mapKey)
  rows.delete(mapKey)
  return row
})

const deleteMany = mock(async ({ where }: any): Promise<any> => {
  let count = 0
  for (const [mapKey, row] of rows) {
    if (row.projectId === where.projectId) {
      rows.delete(mapKey)
      count += 1
    }
  }
  return { count }
})

const aggregate = mock(async (args: any): Promise<any> => {
  const matching = Array.from(rows.values()).filter((row) => {
    if (args.where?.projectId) return row.projectId === args.where.projectId
    return true
  })
  if (args._count) {
    return { _sum: { size: BigInt(matching.reduce((sum, row) => sum + Number(row.size), 0)) }, _count: { _all: matching.length } }
  }
  return { _sum: { size: BigInt(matching.reduce((sum, row) => sum + Number(row.size), 0)) } }
})

const workspaceFindUnique = mock(async (_: any): Promise<any> => ({ instanceSize: 'small' }))
const storageUsageFindUnique = mock(async (_: any): Promise<any> => null)
const projectFindMany = mock(async (_: any): Promise<any[]> => [])

mock.module('../lib/prisma', () => ({
  prisma: {
    projectBucketObject: {
      findUnique,
      upsert,
      findMany,
      delete: deleteRow,
      deleteMany,
      aggregate,
    },
    workspace: { findUnique: workspaceFindUnique },
    storageUsage: { findUnique: storageUsageFindUnique },
    project: { findMany: projectFindMany },
  },
}))

// The gate's "can this workspace pay?" answer; flipped per test.
const balance = { ok: true as boolean, reason: undefined as string | undefined }
mock.module('../services/billing.service', () => ({
  checkUsageBalance: async (_workspaceId: string, _minimumUsd: number) => balance,
}))

mock.module('../lib/s3', () => ({
  getS3Client: () => {
    throw new Error('no S3 in the filesystem driver')
  },
  getS3PublicClient: () => {
    throw new Error('no S3 in the filesystem driver')
  },
}))

const {
  BucketKeyExistsError,
  BucketUploadRejectedError,
  abortBucketUpload,
  bucketObjectPublicUrl,
  bucketUsage,
  checkBucketUploadAllowed,
  completeBucketUpload,
  createBucketUpload,
  decodeUploadToken,
  deleteBucketObject,
  headBucketObject,
  isLocalBucketMode,
  listBucketObjects,
  purgeProjectBucket,
  putBucketStream,
  readBucketObject,
  signBucketObjectToken,
  verifyBucketObjectToken,
} = await import('../services/project-bucket.service')

const { INSTANCE_SIZES } = await import('../config/instance-sizes')

const PROJECT = { id: 'p_media', workspaceId: 'ws_media' }
const SMALL_LIMIT = INSTANCE_SIZES.small.storageLimitBytes
const GB = 1024 ** 3

// ─── env ────────────────────────────────────────────────────────────────────

const ENV_VARS = [
  'SHOGO_LOCAL_MODE',
  'PROJECT_BUCKET_DIR',
  'S3_PROJECT_BUCKET',
  'STORAGE_BILLING_MODE',
  'SHOGO_BUCKET_CDN_BASE',
  'PUBLISH_DOMAIN',
]
const savedEnv: Record<string, string | undefined> = {}
let bucketDir = ''

beforeAll(() => {
  for (const name of ENV_VARS) savedEnv[name] = process.env[name]
})

afterAll(() => {
  for (const name of ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  if (bucketDir) rmSync(bucketDir, { recursive: true, force: true })
})

let consoleError: ReturnType<typeof spyOn>

beforeEach(() => {
  bucketDir = mkdtempSync(join(tmpdir(), 'sho491-bucket-'))
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.PROJECT_BUCKET_DIR = bucketDir
  delete process.env.S3_PROJECT_BUCKET
  delete process.env.STORAGE_BILLING_MODE
  delete process.env.SHOGO_BUCKET_CDN_BASE
  delete process.env.PUBLISH_DOMAIN

  rows.clear()
  balance.ok = true
  balance.reason = undefined
  workspaceFindUnique.mockImplementation(async () => ({ instanceSize: 'small' }))
  storageUsageFindUnique.mockImplementation(async () => null)
  projectFindMany.mockImplementation(async () => [])
  consoleError = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  rmSync(bucketDir, { recursive: true, force: true })
  bucketDir = ''
})

// ─── desktop round trip ─────────────────────────────────────────────────────

describe('filesystem driver (desktop)', () => {
  test('ticket → PUT → complete indexes the object with its real size', async () => {
    expect(isLocalBucketMode()).toBe(true)

    const ticket = await createBucketUpload(
      PROJECT,
      { key: 'media/hero.png', visibility: 'public', size: 4, contentType: 'image/png', overwrite: false },
      'http://localhost:3000',
    )
    expect(ticket.mode).toBe('single')
    expect(ticket.url).toBe(`http://localhost:3000/api/projects/p_media/bucket/uploads/${ticket.uploadId}`)
    expect(ticket.publicUrl).toBe('http://localhost:3000/api/bucket/p_media/public/media/hero.png')
    expect(ticket.completeUrl).toBe(
      `http://localhost:3000/api/projects/p_media/bucket/uploads/${ticket.uploadId}/complete`,
    )

    const token = decodeUploadToken(ticket.uploadId)
    expect(token).toEqual({ k: 'media/hero.png', v: 'public' })

    const stored = await putBucketStream(
      PROJECT,
      { key: 'media/hero.png', visibility: 'public', contentType: 'image/png', declaredSize: 4 },
      new Response('abcd').body,
    )
    expect(stored).toMatchObject({ key: 'media/hero.png', visibility: 'public', size: 4 })
    expect(stored.etag).toBeTruthy()

    const completed = await completeBucketUpload(PROJECT, decodeUploadToken(ticket.uploadId)!)
    expect(completed.size).toBe(4)
    expect(completed.etag).toBeTruthy()
    // The type is recorded in the index (not echoed by `complete`), so a later
    // download can answer with it.
    expect((await headBucketObject(PROJECT.id, 'public', 'media/hero.png'))?.contentType).toBe('image/png')
    expect(completed.publicUrl).toBe('http://localhost:3000/api/bucket/p_media/public/media/hero.png')
  })

  test('a duplicate key is refused unless the caller asked to overwrite', async () => {
    await putBucketStream(
      PROJECT,
      { key: 'dup.txt', visibility: 'public', declaredSize: 1 },
      new Response('a').body,
    )
    await completeBucketUpload(PROJECT, { k: 'dup.txt', v: 'public' })

    await expect(
      createBucketUpload(
        PROJECT,
        { key: 'dup.txt', visibility: 'public', size: 1, contentType: null, overwrite: false },
        'http://localhost:3000',
      ),
    ).rejects.toBeInstanceOf(BucketKeyExistsError)

    // Overwrite is allowed, and only the growth is gated (a same-size replace
    // asks the wallet for nothing).
    const ticket = await createBucketUpload(
      PROJECT,
      { key: 'dup.txt', visibility: 'public', size: 1, contentType: null, overwrite: true },
      'http://localhost:3000',
    )
    expect(ticket.key).toBe('dup.txt')
  })

  test('list pages by key and filters on prefix + visibility', async () => {
    for (const [key, visibility] of [
      ['a/one.txt', 'public'],
      ['a/two.txt', 'public'],
      ['b/three.txt', 'public'],
      ['a/secret.txt', 'private'],
    ] as const) {
      await putBucketStream(PROJECT, { key, visibility, declaredSize: 3 }, new Response('abc').body)
      await completeBucketUpload(PROJECT, { k: key, v: visibility })
    }

    const page = await listBucketObjects(PROJECT.id, { limit: 2 })
    expect(page.objects.map((object) => object.key)).toEqual(['a/one.txt', 'a/secret.txt'])
    expect(page.cursor).toBe('a/secret.txt')

    const next = await listBucketObjects(PROJECT.id, { limit: 2, cursor: page.cursor })
    expect(next.objects.map((object) => object.key)).toEqual(['a/two.txt', 'b/three.txt'])
    expect(next.cursor).toBeNull()

    const prefixed = await listBucketObjects(PROJECT.id, { prefix: 'a/', visibility: 'public' })
    expect(prefixed.objects.map((object) => object.key)).toEqual(['a/one.txt', 'a/two.txt'])
  })

  test('head reads through to disk; delete removes bytes and row; delete is idempotent', async () => {
    await putBucketStream(
      PROJECT,
      { key: 'docs/report.pdf', visibility: 'public', contentType: 'application/pdf', declaredSize: 5 },
      new Response('12345').body,
    )
    // `putBucketStream` records the row itself (desktop has no separate
    // complete step that knows the size), so head answers from the index.
    const before = await headBucketObject(PROJECT.id, 'public', 'docs/report.pdf')
    expect(before?.size).toBe(5)
    expect(before?.contentType).toBe('application/pdf')

    await completeBucketUpload(PROJECT, { k: 'docs/report.pdf', v: 'public' })
    expect(await deleteBucketObject(PROJECT.id, 'public', 'docs/report.pdf')).toBe(true)
    expect(await headBucketObject(PROJECT.id, 'public', 'docs/report.pdf')).toBeNull()
    expect(await deleteBucketObject(PROJECT.id, 'public', 'docs/report.pdf')).toBe(false)
  })

  test('a private object serves only through a signed URL', async () => {
    await putBucketStream(
      PROJECT,
      { key: 'secret.txt', visibility: 'private', declaredSize: 4 },
      new Response('nope').body,
    )
    await completeBucketUpload(PROJECT, { k: 'secret.txt', v: 'private' })

    const token = signBucketObjectToken(PROJECT.id, 'private', 'secret.txt', 60)
    expect(verifyBucketObjectToken(PROJECT.id, 'private', 'secret.txt', token)).toBe(true)
    expect(verifyBucketObjectToken(PROJECT.id, 'private', 'secret.txt', 'garbage')).toBe(false)
    // A token for one object cannot read another, and a public token cannot
    // read the private copy.
    expect(verifyBucketObjectToken(PROJECT.id, 'private', 'other.txt', token)).toBe(false)
    expect(verifyBucketObjectToken(PROJECT.id, 'public', 'secret.txt', token)).toBe(false)
    // Expiry is enforced.
    expect(verifyBucketObjectToken(PROJECT.id, 'private', 'secret.txt', token, Date.now() + 120_000)).toBe(false)
  })

  test('read honours a byte range', async () => {
    await putBucketStream(
      PROJECT,
      { key: 'video.bin', visibility: 'public', declaredSize: 10 },
      new Response('0123456789').body,
    )
    const stream = await readBucketObject(PROJECT.id, 'public', 'video.bin', { start: 2, end: 5 })
    expect(stream).not.toBeNull()
    const text = await new Response(stream!.body).text()
    expect(text).toBe('2345')
    // A ranged read reports the length of the range (its 206 Content-Length),
    // not the object's total size.
    expect(stream!.size).toBe(4)
    expect(stream!.contentType).toBe('application/octet-stream')
  })

  test('purging a project removes every object and leaves the prefix empty', async () => {
    for (const key of ['a/x.txt', 'a/y.txt', 'b/z.txt']) {
      await putBucketStream(PROJECT, { key, visibility: 'public', declaredSize: 1 }, new Response('x').body)
      await completeBucketUpload(PROJECT, { k: key, v: 'public' })
    }
    const result = await purgeProjectBucket(PROJECT.id)
    expect(result).toEqual({ deleted: 3, empty: true })
    expect(rows.size).toBe(0)
  })

  test('an upload ticket can be abandoned without storing anything', async () => {
    const ticket = await createBucketUpload(
      PROJECT,
      { key: 'big.bin', visibility: 'public', size: 10, contentType: null, overwrite: false },
      'http://localhost:3000',
    )
    await abortBucketUpload(PROJECT.id, decodeUploadToken(ticket.uploadId)!)
    expect(await headBucketObject(PROJECT.id, 'public', 'big.bin')).toBeNull()
  })

  test('desktop never blocks on the allowance and reports the API as its public base', async () => {
    balance.ok = false
    const gate = await checkBucketUploadAllowed(PROJECT.workspaceId, 10 * GB)
    expect(gate.ok).toBe(true)
    expect(gate.allowanceBytes).toBe(Number.MAX_SAFE_INTEGER)

    const savedOrigin = process.env.SHOGO_PUBLIC_API_URL
    process.env.SHOGO_PUBLIC_API_URL = 'http://localhost:3000'
    try {
      const usage = await bucketUsage(PROJECT)
      expect(usage.billingMode).toBe('shadow')
      // Desktop has no CDN: public objects are served by this API, so the base
      // is its origin (the SDK appends `/api/bucket/...`).
      expect(usage.publicBaseUrl).toBe('http://localhost:3000')
    } finally {
      if (savedOrigin === undefined) delete process.env.SHOGO_PUBLIC_API_URL
      else process.env.SHOGO_PUBLIC_API_URL = savedOrigin
    }
  })
})

// ─── cloud gate ─────────────────────────────────────────────────────────────

describe('storage gate (cloud)', () => {
  beforeEach(() => {
    delete process.env.SHOGO_LOCAL_MODE
    delete process.env.PROJECT_BUCKET_DIR
    process.env.S3_PROJECT_BUCKET = 'shogo-project-buckets'
    // Nothing landed since the last measurement.
    storageUsageFindUnique.mockImplementation(async () => ({
      billableBytes: BigInt(0),
      lastCalculatedAt: new Date(Date.now() + 60_000),
    }))
  })

  test('under the allowance an upload is always allowed', async () => {
    balance.ok = false
    const gate = await checkBucketUploadAllowed(PROJECT.workspaceId, 1 * GB)
    expect(gate.ok).toBe(true)
    expect(gate.usedBytes).toBe(0)
    expect(gate.allowanceBytes).toBe(SMALL_LIMIT)
  })

  test('over the allowance it goes through only when the wallet can pay', async () => {
    storageUsageFindUnique.mockImplementation(async () => ({
      billableBytes: BigInt(SMALL_LIMIT),
      lastCalculatedAt: new Date(Date.now() + 60_000),
    }))
    process.env.STORAGE_BILLING_MODE = 'enforce'

    balance.ok = true
    expect((await checkBucketUploadAllowed(PROJECT.workspaceId, 1)).ok).toBe(true)

    balance.ok = false
    balance.reason = 'usage_limit_reached'
    const refused = await checkBucketUploadAllowed(PROJECT.workspaceId, 1)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('usage_limit_reached')
    expect(refused.usedBytes).toBe(SMALL_LIMIT)
  })

  test('shadow mode records the numbers but blocks nothing', async () => {
    storageUsageFindUnique.mockImplementation(async () => ({
      billableBytes: BigInt(SMALL_LIMIT * 2),
      lastCalculatedAt: new Date(Date.now() + 60_000),
    }))
    balance.ok = false
    const gate = await checkBucketUploadAllowed(PROJECT.workspaceId, 1)
    expect(gate.ok).toBe(true)
    expect(gate.usedBytes).toBe(SMALL_LIMIT * 2)
  })

  test('an upload the wallet cannot cover is a 402 body naming the workspace and the numbers', async () => {
    const gate = {
      ok: false as const,
      reason: 'usage_limit_reached' as const,
      usedBytes: SMALL_LIMIT + 5,
      allowanceBytes: SMALL_LIMIT,
      usdPerGbMonth: 0.02,
    }
    const { bucketPaymentRequiredBody } = await import('../services/project-bucket.service')
    const body = bucketPaymentRequiredBody(gate as any, PROJECT.workspaceId)
    expect(body.error.code).toBe('bucket_payment_required')
    expect(body.error.reason).toBe('usage_limit_reached')
    expect(body.error.usedBytes).toBe(SMALL_LIMIT + 5)
    expect(body.error.allowanceBytes).toBe(SMALL_LIMIT)
    expect(body.error.billingUrl).toContain('/billing?workspace=ws_media')
  })
})

// ─── public URL shape ───────────────────────────────────────────────────────

describe('public URLs', () => {
  test('cloud serves public objects from the CDN host', () => {
    delete process.env.SHOGO_LOCAL_MODE
    delete process.env.PROJECT_BUCKET_DIR
    process.env.PUBLISH_DOMAIN = 'shogo.one'
    expect(bucketObjectPublicUrl('p_media', 'a/hero.png')).toBe(
      'https://cdn.shogo.one/p_media/a/hero.png',
    )

    process.env.SHOGO_BUCKET_CDN_BASE = 'https://bucket.example.com/'
    expect(bucketObjectPublicUrl('p_media', 'a/hero.png')).toBe(
      'https://bucket.example.com/p_media/a/hero.png',
    )
    delete process.env.SHOGO_BUCKET_CDN_BASE
    delete process.env.PUBLISH_DOMAIN
  })

  test('a key with spaces or a hash is percent-encoded per segment', () => {
    delete process.env.SHOGO_LOCAL_MODE
    delete process.env.PROJECT_BUCKET_DIR
    process.env.PUBLISH_DOMAIN = 'shogo.one'
    expect(bucketObjectPublicUrl('p_media', 'a b/c#d.png')).toBe(
      'https://cdn.shogo.one/p_media/a%20b/c%23d.png',
    )
    delete process.env.PUBLISH_DOMAIN
  })
})

// ─── the gate is what the 402 quotes ────────────────────────────────────────

describe('BucketUploadRejectedError', () => {
  test('carries the gate and the workspace so the route can print both', () => {
    const gate = {
      ok: false as const,
      reason: 'payment_method_required' as const,
      usedBytes: 10,
      allowanceBytes: 5,
      usdPerGbMonth: 0.02,
    }
    const error = new BucketUploadRejectedError(gate as any, 'ws_1')
    expect(error.code).toBe('bucket_payment_required')
    expect(error.gate).toBe(gate)
    expect(error.workspaceId).toBe('ws_1')
  })
})
