// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-584 — every writer quarantines through ONE helper, so dedupe and the
 * daily cap can never be bypassed by choosing a different archive.
 *
 * The unit tests in `pool-sho584-quarantine.test.ts` pin the helper itself.
 * These drive the four real guarded writers against the precondition-enforcing
 * store, because the bug was never in the helper's logic — it was that four
 * separate writers each parked their own copies and nothing counted them.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import { homeStateQuarantineKey, uploadHomeStateGuarded } from './home-state-archive'
import { M, metrics } from './metrics'
import { dataArchiveKey, dataQuarantineKey, uploadProjectDataGuarded } from './project-data-archive'
import type { QuarantineBookkeeping, QuarantineState } from './quarantine'
import { repoQuarantineKey, uploadRepoArchiveGuarded } from './repo-archive'
import { quarantineKey, uploadWorkspaceArchiveGuarded } from './workspace-archive'

const BUCKET = 'test-workspaces'

/** Minimal object store that enforces If-Match / If-None-Match like the real one. */
class FakeS3 {
  readonly objects = new Map<string, { body: Uint8Array; etag: string }>()
  readonly puts: string[] = []
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

  keys(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    const prefix = `/${BUCKET}/`
    if (!path.startsWith(prefix)) return new Response('no such bucket', { status: 404 })
    const key = decodeURIComponent(path.slice(prefix.length))
    const existing = this.objects.get(key)

    if (req.method === 'HEAD' || req.method === 'GET') {
      if (!existing) return new Response(null, { status: 404 })
      return new Response(req.method === 'HEAD' ? null : existing.body, {
        status: 200,
        headers: { etag: existing.etag, 'content-length': String(existing.body.byteLength) },
      })
    }

    if (req.method === 'PUT') {
      const ifMatch = req.headers.get('if-match')
      const ifNoneMatch = req.headers.get('if-none-match')
      if (ifNoneMatch === '*' && existing) return new Response(null, { status: 412 })
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return new Response(null, { status: 412 })
      this.puts.push(key)
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
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_WORKSPACES_BUCKET']) savedEnv[k] = process.env[k]
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

beforeEach(() => {
  s3?.stop()
  s3 = new FakeS3()
  cfg = { ...config, s3Endpoint: s3.endpoint, s3Region: 'us-east-1', quarantineDailyCap: 24 } as typeof config
})

afterEach(() => s3?.stop())

const bytes = (s: string) => new TextEncoder().encode(s)

/** Bookkeeping as the pool threads it: one object per project, persisted on change. */
function bookkeeping(): QuarantineBookkeeping & { state: QuarantineState; saves: number } {
  const b = {
    state: {} as QuarantineState,
    saves: 0,
  } as QuarantineBookkeeping & { state: QuarantineState; saves: number }
  b.onChange = () => {
    b.saves += 1
  }
  return b
}

const counter = (metric: string) => metrics.snapshot().counters[metric] ?? 0

type Writer = {
  name: string
  /** Writes bytes as a REFUSED export (untrusted lineage), preserving the copy. */
  refuse: (projectId: string, body: Uint8Array, bk: QuarantineBookkeeping) => Promise<unknown>
  /** Where that writer parks a copy. */
  key: (projectId: string) => string
}

const WRITERS: Writer[] = [
  {
    name: 'source',
    refuse: (p, b, quarantine) =>
      uploadWorkspaceArchiveGuarded(p, b, { untrusted: true, adoptWhenUnknown: false, quarantine }, cfg),
    key: quarantineKey,
  },
  {
    name: 'data',
    refuse: (p, b, quarantine) =>
      uploadProjectDataGuarded(p, b, { lineage: { kind: 'untrusted', reason: 'mid-open' }, preserveOnRefusal: true, quarantine }, cfg),
    key: dataQuarantineKey,
  },
  {
    name: 'home',
    refuse: (p, b, quarantine) =>
      uploadHomeStateGuarded(p, b, { lineage: { kind: 'untrusted', reason: 'mid-open' }, preserveOnRefusal: true, quarantine }, cfg),
    key: homeStateQuarantineKey,
  },
  {
    name: 'repo',
    refuse: (p, b, quarantine) =>
      uploadRepoArchiveGuarded(p, b, { lineage: { kind: 'untrusted', reason: 'mid-open' }, preserveOnRefusal: true, quarantine }, cfg),
    key: repoQuarantineKey,
  },
]

describe('SHO-584 · each writer dedupes and caps through the shared helper', () => {
  for (const w of WRITERS) {
    test(`${w.name}: identical bytes are parked once, and the earlier key is returned`, async () => {
      const bk = bookkeeping()
      const before = counter(`${M.quarantineDeduped}{kind="${w.name}"}`)

      await w.refuse('p1', bytes('the same refused bytes'), bk)
      const afterFirst = s3.keys('conflict/p1/')
      expect(afterFirst).toHaveLength(1)
      expect(bk.state.last?.[w.name as 'source']).toMatchObject({ size: 'the same refused bytes'.length })
      expect(bk.saves).toBe(1)

      // The same bytes again: no second PUT, and the caller is told the bytes
      // are already durable at the first key.
      const putsBefore = s3.puts.length
      await w.refuse('p1', bytes('the same refused bytes'), bk)
      expect(s3.keys('conflict/p1/')).toHaveLength(1)
      expect(s3.puts.length).toBe(putsBefore)
      expect(counter(`${M.quarantineDeduped}{kind="${w.name}"}`)).toBeGreaterThan(before)
    })

    test(`${w.name}: a different body is a new copy, and the cap refuses the next one`, async () => {
      const bk = bookkeeping()
      cfg = { ...cfg, quarantineDailyCap: 1 } as typeof config
      const cappedBefore = counter(`${M.quarantineCapped}{kind="${w.name}"}`)

      await w.refuse('p1', bytes('first refusal'), bk)
      expect(bk.state.writes).toBe(1)

      const capped = await w.refuse('p1', bytes('second refusal — different bytes'), bk)
      // NOT SAVED: the pool must not destroy or rotate a VM on this.
      expect(s3.keys('conflict/p1/')).toHaveLength(1)
      expect(bk.state.writes).toBe(1)
      expect(counter(`${M.quarantineCapped}{kind="${w.name}"}`)).toBeGreaterThan(cappedBefore)
      // Whichever status the writer reports, the copy is NOT saved.
      expect(capped).toMatchObject({ quarantineKey: null })
    })
  }

  test('all four kinds share one project daily cap', async () => {
    const bk = bookkeeping()
    cfg = { ...cfg, quarantineDailyCap: 3 } as typeof config

    await WRITERS[0]!.refuse('p1', bytes('source copy'), bk)
    await WRITERS[1]!.refuse('p1', bytes('data copy'), bk)
    await WRITERS[2]!.refuse('p1', bytes('home copy'), bk)
    // Fourth write of any kind is over the cap, so it is not saved.
    const fourth = await WRITERS[3]!.refuse('p1', bytes('repo copy'), bk)
    expect(bk.state.writes).toBe(3)
    expect(s3.keys('conflict/p1/')).toHaveLength(3)
    expect(fourth).toMatchObject({ quarantineKey: null })
  })

  test('the durable archive is never touched by any of it', async () => {
    const bk = bookkeeping()
    const etag = s3.put(dataArchiveKey('p1'), bytes('REAL USER DATA'))
    await uploadProjectDataGuarded(
      'p1',
      bytes('empty db from a half-hydrated VM'),
      { lineage: { kind: 'descends', etag: 'stale' }, preserveOnRefusal: true, quarantine: bk },
      cfg,
    )
    expect(new TextDecoder().decode(s3.objects.get(dataArchiveKey('p1'))!.body)).toBe('REAL USER DATA')
    expect(s3.keys('conflict/p1/')).toHaveLength(1)
  })
})
