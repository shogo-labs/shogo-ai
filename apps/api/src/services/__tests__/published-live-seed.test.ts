// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Reading the live database out of a published environment's archive (SHO-514).
 *
 * The archive also carries the app's uploads, so this is a security boundary as
 * much as a data one: only `prisma/` database files may be extracted, and an
 * absent or oversized archive must be answered by name (fall back, or refuse the
 * switch) rather than by accident.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'

let stored: { body: Buffer } | null = null
let failWith: any = null

mock.module('../../lib/publish-storage', () => ({
  PUBLISH_DATA_BUCKET: 'shogo-published-data-staging',
  publishS3Client: {
    async send(command: any) {
      const name = command.constructor.name
      if (failWith) throw failWith
      if (name === 'HeadObjectCommand') {
        if (!stored) {
          const err: any = new Error('NotFound')
          err.name = 'NotFound'
          err.$metadata = { httpStatusCode: 404 }
          throw err
        }
        return { ContentLength: stored.body.length }
      }
      if (name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => new Uint8Array(stored!.body) } }
      }
      throw new Error(`unexpected command ${name}`)
    },
  },
}))

const { MAX_LIVE_SEED_ARCHIVE_BYTES, readLiveSeedArchive } = await import('../published-live-seed')

const roots: string[] = []

/** An archive shaped like a published pod's `data.tar.gz`. */
async function archiveWith(entries: Record<string, string>): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-live-archive-'))
  roots.push(dir)
  for (const [rel, body] of Object.entries(entries)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  const out = join(dir, 'data.tar.gz')
  await tar.create({ gzip: true, file: out, cwd: dir, portable: true }, Object.keys(entries).map((e) => e.split('/')[0]!))
  return Buffer.from(await Bun.file(out).bytes())
}

/** What the returned archive actually contains. */
async function members(base64: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-live-members-'))
  roots.push(dir)
  const file = join(dir, 'seed.tar.gz')
  writeFileSync(file, Buffer.from(base64, 'base64'))
  const names: string[] = []
  await tar.list({
    file,
    // Files only: the archive keeps its directory entries, and those are not
    // what the seed consists of.
    onentry: (entry: any) => {
      if (entry.type === 'File') names.push(entry.path)
    },
  })
  return names.sort()
}

beforeEach(() => {
  stored = null
  failWith = null
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('readLiveSeedArchive', () => {
  it('carries only the database files, not the app uploads beside them', async () => {
    stored = {
      body: await archiveWith({
        'prisma/dev.db': 'sqlite-bytes',
        'prisma/dev.db-wal': 'wal-bytes',
        'uploads/photo.png': 'png',
        'storage/doc.pdf': 'pdf',
      }),
    }

    const res = await readLiveSeedArchive('live-app')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value).not.toBeNull()
    expect(await members(res.value!.archive)).toEqual(['prisma/dev.db', 'prisma/dev.db-wal'])
  })

  it('returns nothing to carry over when the archive has no database', async () => {
    stored = { body: await archiveWith({ 'uploads/photo.png': 'png' }) }
    const res = await readLiveSeedArchive('live-app')
    expect(res).toEqual({ ok: true, value: null })
  })

  it('returns nothing to carry over when the environment has never been live', async () => {
    stored = null
    const res = await readLiveSeedArchive('live-app')
    expect(res).toEqual({ ok: true, value: null })
  })

  it('returns nothing to carry over without a subdomain (an unpublished environment)', async () => {
    stored = { body: await archiveWith({ 'prisma/dev.db': 'sqlite-bytes' }) }
    const res = await readLiveSeedArchive('')
    expect(res).toEqual({ ok: true, value: null })
  })

  it('refuses an archive larger than a seed may be, by name', async () => {
    stored = { body: Buffer.alloc(MAX_LIVE_SEED_ARCHIVE_BYTES + 1) }
    const res = await readLiveSeedArchive('live-app')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('live_seed_too_large')
    expect(res.message).toContain('64 MB')
  })

  it('reports an unreadable archive instead of silently seeding the builder dev.db', async () => {
    stored = { body: Buffer.from('not a gzip') }
    const res = await readLiveSeedArchive('live-app')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('live_seed_unreadable')
  })
})
