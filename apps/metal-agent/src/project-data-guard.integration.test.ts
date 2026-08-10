// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * End-to-end test of the writable-state guard against an object store that
 * actually ENFORCES preconditions.
 *
 * The pure-decision tests in `project-data-archive.test.ts` prove the guard
 * chooses the right precondition. They cannot prove the thing that matters —
 * that the precondition is applied atomically with the write. The previous
 * design read an ETag and then wrote if it looked right, which is safe in
 * every sequential test and unsafe in production, where the periodic exporter
 * and `suspend()` interleave. Only a server that adjudicates the write can
 * tell those two designs apart, so this file stands one up: a minimal S3
 * speaking path-style HEAD/GET/PUT with `If-Match` / `If-None-Match`.
 *
 * It exercises the real code path throughout — Bun's S3 client for reads, the
 * hand-rolled SigV4 writer for writes — so an addressing or signing mismatch
 * between the two would fail here rather than in production.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { config } from './config'
import {
  DATA_MAX_BYTES,
  dataArchiveKey,
  dataS3Target,
  fetchProjectDataArchive,
  uploadProjectDataGuarded,
} from './project-data-archive'

const BUCKET = 'test-workspaces'

/** Minimal, precondition-enforcing object store. */
class FakeS3 {
  readonly objects = new Map<string, { body: Uint8Array; etag: string }>()
  readonly requests: Array<{ method: string; key: string }> = []
  private seq = 0
  private server: ReturnType<typeof Bun.serve>

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) })
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    this.server.stop(true)
  }

  put(key: string, body: Uint8Array): string {
    const etag = `"etag-${++this.seq}"`
    this.objects.set(key, { body, etag })
    return etag
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    const prefix = `/${BUCKET}/`
    if (!path.startsWith(prefix)) return new Response('no such bucket', { status: 404 })
    const key = decodeURIComponent(path.slice(prefix.length))
    this.requests.push({ method: req.method, key })

    const existing = this.objects.get(key)

    if (req.method === 'HEAD' || req.method === 'GET') {
      if (!existing) return new Response(null, { status: 404 })
      return new Response(req.method === 'HEAD' ? null : existing.body, {
        status: 200,
        headers: {
          etag: existing.etag,
          'content-length': String(existing.body.byteLength),
        },
      })
    }

    if (req.method === 'PUT') {
      const ifMatch = req.headers.get('if-match')
      const ifNoneMatch = req.headers.get('if-none-match')
      // The adjudication the whole design rests on: the store decides, and it
      // does so atomically with respect to other writes.
      if (ifNoneMatch === '*' && existing) return new Response(null, { status: 412 })
      if (ifMatch && (!existing || existing.etag !== ifMatch)) {
        return new Response(null, { status: 412 })
      }
      const etag = this.put(key, new Uint8Array(await req.arrayBuffer()))
      return new Response(null, { status: 200, headers: { etag } })
    }

    return new Response(null, { status: 405 })
  }
}

let s3: FakeS3
let cfg: typeof config
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_WORKSPACES_BUCKET']) {
    savedEnv[k] = process.env[k]
  }
  process.env.AWS_ACCESS_KEY_ID = 'test-key'
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
  process.env.S3_WORKSPACES_BUCKET = BUCKET
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function freshStore(): void {
  s3?.stop()
  s3 = new FakeS3()
  cfg = { ...config, s3Endpoint: s3.endpoint, s3Region: 'us-east-1' } as typeof config
}

afterEach(() => s3?.stop())

const bytes = (s: string) => new TextEncoder().encode(s)
const stored = (projectId: string) => s3.objects.get(dataArchiveKey(projectId))

describe('writable-state guard against a precondition-enforcing store', () => {
  test('a first backup creates the archive', async () => {
    freshStore()
    const out = await uploadProjectDataGuarded(
      'p1',
      bytes('first database'),
      { lineage: { kind: 'create-only' } },
      cfg,
    )
    expect(out.status).toBe('created')
    expect(stored('p1')!.body).toEqual(bytes('first database'))
  })

  test('a workspace that descends from the archive may replace it', async () => {
    freshStore()
    const etag = s3.put(dataArchiveKey('p1'), bytes('v1'))

    const out = await uploadProjectDataGuarded(
      'p1',
      bytes('v2 with more rows'),
      { lineage: { kind: 'descends', etag } },
      cfg,
    )
    expect(out.status).toBe('written')
    expect(stored('p1')!.body).toEqual(bytes('v2 with more rows'))
    // The write's own response carries the new lineage anchor — no second
    // round-trip, and therefore no window in which it could go stale.
    expect((out as { etag: string }).etag).toBe(stored('p1')!.etag)
  })

  test('a stale lineage CANNOT overwrite — the archive is left byte-for-byte intact', async () => {
    freshStore()
    const staleEtag = s3.put(dataArchiveKey('p1'), bytes('old'))
    s3.put(dataArchiveKey('p1'), bytes('REAL USER DATA')) // someone else wrote

    const out = await uploadProjectDataGuarded(
      'p1',
      bytes('empty db'),
      { lineage: { kind: 'descends', etag: staleEtag } },
      cfg,
    )
    expect(out.status).toBe('conflict')
    expect(stored('p1')!.body).toEqual(bytes('REAL USER DATA'))
  })

  test('a create-only writer cannot overwrite an existing archive', async () => {
    freshStore()
    s3.put(dataArchiveKey('p1'), bytes('REAL USER DATA'))

    const out = await uploadProjectDataGuarded(
      'p1',
      bytes('empty db'),
      { lineage: { kind: 'create-only' } },
      cfg,
    )
    expect(out).toMatchObject({ status: 'conflict', reason: 'raced-create' })
    expect(stored('p1')!.body).toEqual(bytes('REAL USER DATA'))
  })

  test('an untrusted workspace never reaches the store at all', async () => {
    freshStore()
    s3.put(dataArchiveKey('p1'), bytes('REAL USER DATA'))
    const before = s3.requests.length

    const out = await uploadProjectDataGuarded(
      'p1',
      bytes('empty db'),
      { lineage: { kind: 'untrusted', reason: 'hydrate failed' } },
      cfg,
    )
    expect(out).toMatchObject({ status: 'refused', reason: 'hydrate failed' })
    expect(s3.requests.length).toBe(before)
    expect(stored('p1')!.body).toEqual(bytes('REAL USER DATA'))
  })

  test('a final untrusted export is preserved in quarantine, not dropped', async () => {
    // Whatever the user did in a VM whose hydrate failed exists nowhere else.
    freshStore()
    s3.put(dataArchiveKey('p1'), bytes('REAL USER DATA'))

    const out = await uploadProjectDataGuarded(
      'p1',
      bytes('work done after a failed hydrate'),
      { lineage: { kind: 'untrusted', reason: 'hydrate failed' }, preserveOnRefusal: true },
      cfg,
    )
    expect(out.status).toBe('refused')
    const qkey = (out as { quarantineKey: string }).quarantineKey
    expect(qkey).toContain('conflict/p1/')
    expect(s3.objects.get(qkey)!.body).toEqual(bytes('work done after a failed hydrate'))
    expect(stored('p1')!.body).toEqual(bytes('REAL USER DATA'))
  })

  test('an oversized archive is rejected before any network call', async () => {
    freshStore()
    // Only `byteLength` is read before the size check short-circuits, so the
    // test does not need to allocate a gigabyte to exercise it.
    const huge = { byteLength: DATA_MAX_BYTES + 1 } as Uint8Array

    const out = await uploadProjectDataGuarded(
      'p1',
      huge,
      { lineage: { kind: 'create-only' } },
      cfg,
    )
    expect(out).toMatchObject({ status: 'too-large', limit: DATA_MAX_BYTES })
    expect(s3.requests).toHaveLength(0)
  })

  test('an unset endpoint falls back to AWS rather than silently skipping writes', () => {
    // A `skipped` outcome looks like a healthy no-op in the logs, so getting
    // here by misconfiguration would mean believing backups run while nothing
    // is stored. The read path defaults the same way.
    freshStore()
    const target = dataS3Target({ ...cfg, s3Endpoint: '', s3Region: 'us-west-2' } as typeof config)
    expect(target).not.toBeNull()
    expect(target!.endpoint).toBe('https://s3.us-west-2.amazonaws.com')
  })

  test('no credentials means no writes attempted', () => {
    freshStore()
    const saved = process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_ACCESS_KEY_ID
    try {
      expect(dataS3Target(cfg)).toBeNull()
    } finally {
      process.env.AWS_ACCESS_KEY_ID = saved
    }
  })

  test('fetch returns the archive together with the ETag that anchors lineage', async () => {
    freshStore()
    const etag = s3.put(dataArchiveKey('p1'), bytes('durable state'))

    const got = await fetchProjectDataArchive('p1', cfg)
    expect(got!.bytes).toEqual(bytes('durable state'))
    expect(got!.etag).toBe(etag)

    expect(await fetchProjectDataArchive('never-backed-up', cfg)).toBeNull()
  })

  test('concurrent writers with the same lineage: exactly one wins, no data is lost', async () => {
    // This is the case the old read-then-write guard could not handle. Both
    // writers hold the same parent ETag and both pass any check performed
    // before writing; only the store can break the tie.
    freshStore()
    const parent = s3.put(dataArchiveKey('p1'), bytes('base'))

    const results = await Promise.all([
      uploadProjectDataGuarded('p1', bytes('writer-A'), {
        lineage: { kind: 'descends', etag: parent },
      }, cfg),
      uploadProjectDataGuarded('p1', bytes('writer-B'), {
        lineage: { kind: 'descends', etag: parent },
      }, cfg),
      uploadProjectDataGuarded('p1', bytes('writer-C'), {
        lineage: { kind: 'descends', etag: parent },
      }, cfg),
    ])

    const written = results.filter((r) => r.status === 'written')
    const conflicted = results.filter((r) => r.status === 'conflict')
    expect(written).toHaveLength(1)
    expect(conflicted).toHaveLength(2)

    // The stored object is exactly one writer's bytes — never a mix, and never
    // a loser's copy sitting on top of the winner's.
    const final = new TextDecoder().decode(stored('p1')!.body)
    expect(['writer-A', 'writer-B', 'writer-C']).toContain(final)
    expect((written[0] as { etag: string }).etag).toBe(stored('p1')!.etag)
  })

  test('concurrent create-only writers: exactly one seeds the archive', async () => {
    freshStore()
    const results = await Promise.all([
      uploadProjectDataGuarded('p1', bytes('A'), { lineage: { kind: 'create-only' } }, cfg),
      uploadProjectDataGuarded('p1', bytes('B'), { lineage: { kind: 'create-only' } }, cfg),
    ])
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'conflict')).toHaveLength(1)
  })
})
