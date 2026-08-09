// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool.hydrateFromBackup — cold-start workspace hydration wiring.
 *
 * The regression this guards: metal warm-VMs boot from a shared template, so a
 * cold miss (fresh assign, no snapshot to resume) must pull the project's
 * durable source backup HOST-SIDE and stream it to the guest's `/pool/hydrate`
 * control endpoint. If this wiring breaks the guest silently serves the
 * "Project Ready" template instead of the real app — exactly the bug that
 * shipped because nothing asserted the cold-open path hydrates.
 *
 * We drive the private `hydrateFromBackup` directly with an injected archive
 * reference (via the `sourceRef` seam) and a stubbed global `fetch`, so no real
 * S3 / Firecracker host is needed. The resume path is covered by construction:
 * `hydrateFromBackup` is only called from the cold `assign()` branch, never from
 * `resume()`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ArchiveRef } from './archive-ref'
import { config } from './config'
import { MetalWarmPool } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

/** MetalWarmPool subclass exposing the private hydrate + an injectable archive. */
class TestPool extends MetalWarmPool {
  archive: Uint8Array | null = null
  etag: string | null = null
  /** null → the store could not presign, so the host must push the bytes. */
  url: string | null = 'https://s3.example/p1/project-src.tar.gz?X-Amz-Signature=deadbeef'
  loads = 0
  override sourceRef(_projectId: string): Promise<ArchiveRef | null> {
    if (!this.archive) return Promise.resolve(null)
    const bytes = this.archive
    return Promise.resolve({
      etag: this.etag,
      bytes: bytes.byteLength,
      url: this.url,
      load: async () => {
        this.loads++
        return bytes
      },
    })
  }
  hydrate(projectId: string, env: Record<string, string>) {
    // hydrateFromBackup is private; reach it through the instance.
    return (this as any).hydrateFromBackup(projectId, HANDLE, env) as Promise<{ hydrated: boolean; parentEtag?: string }>
  }
  budget(bytes: number) {
    return this.hydrateBudgetMs(bytes)
  }
  bodyFor(bytes: Uint8Array) {
    return this.archiveBody(bytes)
  }
}

function makePool(dir: string, over: Partial<typeof config> = {}): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
    ...over,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool.hydrateFromBackup (cold-start hydration)', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-hydrate-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('hands the guest a URL to pull, and never downloads the archive itself', async () => {
    // THE GUEST-OOM FIX. Pushing bytes cannot work at multi-gigabyte sizes:
    // Bun.serve accumulates a request body in memory whenever the handler reads
    // slower than the wire delivers it (+2423 MB of RSS for a 1 GB body against
    // +94 MB when the reader keeps up), and tar never keeps up. Pulling puts a
    // kernel pipe between download and extraction, which is the only part of
    // this path that has ever applied backpressure.
    const pool = makePool(dir)
    pool.archive = new Uint8Array([1, 2, 3, 4])
    pool.etag = '"abc123"'

    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
    }) as any

    const result = await pool.hydrate('p1', { RUNTIME_AUTH_SECRET: 'secret-token' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/hydrate-url')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ url: pool.url, bytes: 4 })
    // The host downloading it anyway would defeat the entire point — it is the
    // reason a 2 GB archive used to be resident on both sides at once.
    expect(pool.loads).toBe(0)
    // The returned lineage anchors the workspace to the backup we applied, so a
    // later suspend can safely overwrite exactly that object.
    expect(result).toEqual({ hydrated: true, parentEtag: '"abc123"' })
  })

  test('gives the guest a deadline to pull within, and waits longer than it', async () => {
    // The guest holds the transfer open for the whole pull, so the host must
    // outlast the deadline it just handed out — otherwise the host aborts a
    // hydrate that was about to succeed and the project fails to open.
    const pool = makePool(dir, { hydrateTimeoutMs: 60_000, hydrateTimeoutPerMiBMs: 120 })
    pool.archive = new Uint8Array(8 * 1024 * 1024)

    let sent: any
    globalThis.fetch = mock(async (_url: any, init: any) => {
      sent = JSON.parse(init.body)
      return new Response('{}', { status: 200 })
    }) as any

    await pool.hydrate('p-deadline', { RUNTIME_AUTH_SECRET: 'tok' })
    expect(sent.timeoutMs).toBe(pool.budget(8 * 1024 * 1024))
  })

  test('is a no-op returning hydrated:false when the project has no durable backup (new project)', async () => {
    const pool = makePool(dir)
    pool.archive = null // no backup

    let called = false
    globalThis.fetch = mock(async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as any

    const result = await pool.hydrate('brand-new', { RUNTIME_AUTH_SECRET: 'tok' })
    expect(called).toBe(false)
    expect(result).toEqual({ hydrated: false })
  })

  test('throws when the guest rejects the hydrate so assign() logs a real failure', async () => {
    const pool = makePool(dir)
    pool.archive = new Uint8Array([9])

    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any

    await expect(pool.hydrate('p2', { RUNTIME_AUTH_SECRET: 'tok' })).rejects.toThrow(
      /\/pool\/hydrate-url .* failed \(500\)/,
    )
  })

  test('omits the Authorization header when no runtime token is present', async () => {
    const pool = makePool(dir)
    pool.archive = new Uint8Array([7, 7])

    const calls: any[] = []
    globalThis.fetch = mock(async (_url: any, init: any) => {
      calls.push(init)
      return new Response('{}', { status: 200 })
    }) as any

    await pool.hydrate('p3', {})
    expect(calls[0].headers.Authorization).toBeUndefined()
  })
})

describe('falling back to a push when the guest cannot pull', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-fallback-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('a 404 from /pool/hydrate-url means an older guest, so the bytes are pushed', async () => {
    // The two sides deploy independently — the guest runtime ships in a rootfs
    // image, the host in an agent bundle — so for a window the host is new and
    // the guest is not. Without this the entire fleet fails to cold-boot during
    // that window, and hydrate is fail-closed: projects simply do not open.
    const pool = makePool(dir)
    pool.archive = new Uint8Array([5, 6, 7])
    pool.etag = '"e"'

    const seen: Array<{ url: string; sent?: Uint8Array }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      const u = String(url)
      if (u.endsWith('/pool/hydrate-url')) {
        seen.push({ url: u })
        return new Response('not found', { status: 404 })
      }
      seen.push({ url: u, sent: new Uint8Array(await new Response(init.body).arrayBuffer()) })
      return new Response('{}', { status: 200 })
    }) as any

    const result = await pool.hydrate('p-old-guest', { RUNTIME_AUTH_SECRET: 'tok' })

    expect(seen.map((s) => s.url)).toEqual([
      'http://10.0.0.9:8080/pool/hydrate-url',
      'http://10.0.0.9:8080/pool/hydrate',
    ])
    expect(seen[1].sent).toEqual(pool.archive!)
    expect(pool.loads).toBe(1)
    expect(result).toEqual({ hydrated: true, parentEtag: '"e"' })
  })

  test('a store that cannot presign pushes without trying to pull first', async () => {
    const pool = makePool(dir)
    pool.archive = new Uint8Array([1])
    pool.url = null

    const urls: string[] = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      urls.push(String(url))
      await new Response(init.body).arrayBuffer()
      return new Response('{}', { status: 200 })
    }) as any

    await pool.hydrate('p-nopresign', { RUNTIME_AUTH_SECRET: 'tok' })
    expect(urls).toEqual(['http://10.0.0.9:8080/pool/hydrate'])
  })

  test('any other failure from the pull endpoint is an error, not a reason to push', async () => {
    // A 500 means the guest TRIED and failed — pushing after it would turn a
    // clean failure into the multi-gigabyte push this design exists to avoid.
    const pool = makePool(dir)
    pool.archive = new Uint8Array([1])

    const urls: string[] = []
    globalThis.fetch = mock(async (url: any) => {
      urls.push(String(url))
      return new Response('curl exited 22', { status: 500 })
    }) as any

    await expect(pool.hydrate('p-pull-broke', { RUNTIME_AUTH_SECRET: 'tok' })).rejects.toThrow(/500/)
    expect(urls).toEqual(['http://10.0.0.9:8080/pool/hydrate-url'])
    expect(pool.loads).toBe(0)
  })
})

describe('the archive is sent chunked, never as a sized body', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-body-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('the push fallback sends a stream with duplex:half and no Content-Length', async () => {
    // Bun.serve buffers a request body whole when Content-Length is set,
    // whatever the handler does with it: +1978 MB of RSS for a 1 GB body versus
    // +91 MB chunked. Passing a Uint8Array here would look perfectly reasonable
    // in review while making the fallback strictly worse, so it is pinned.
    const pool = makePool(dir)
    pool.archive = new Uint8Array(4 * 1024 * 1024)
    pool.url = null // force the push path

    let init: any
    globalThis.fetch = mock(async (_url: any, i: any) => {
      init = i
      // Drain, or the producing stream never runs.
      await new Response(i.body).arrayBuffer()
      return new Response('{}', { status: 200 })
    }) as any

    await pool.hydrate('p-chunked', { RUNTIME_AUTH_SECRET: 'tok' })

    expect(init.body).toBeInstanceOf(ReadableStream)
    expect(init.duplex).toBe('half')
    expect(ArrayBuffer.isView(init.body)).toBe(false)
    expect(init.headers['Content-Length']).toBeUndefined()
  })

  test('the stream reproduces the archive exactly, in bounded pieces', async () => {
    // Chunking is only safe if it is lossless and actually chunked — one
    // enqueue of the whole buffer would pass the type check above while
    // changing nothing about the memory behaviour.
    const pool = makePool(dir)
    const bytes = new Uint8Array(5 * 1024 * 1024 + 123)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251

    const { body } = pool.bodyFor(bytes)
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value!)
    }

    expect(chunks.length).toBeGreaterThan(1)
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(1024 * 1024)
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let at = 0
    for (const c of chunks) {
      joined.set(c, at)
      at += c.byteLength
    }
    expect(joined).toEqual(bytes)
  })

  test('an empty archive produces an immediately-closed stream', () => {
    const pool = makePool(dir)
    expect(async () => {
      const { body } = pool.bodyFor(new Uint8Array(0))
      const { done } = await body.getReader().read()
      expect(done).toBe(true)
    }).not.toThrow()
  })
})

describe('pool.hydrateBudgetMs (the deadline scales with the archive)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-budget-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a small archive gets the flat allowance and nothing more', () => {
    const pool = makePool(dir, { hydrateTimeoutPerMiBMs: 120 })
    // The median project is well under a MiB; it should not be paying for a
    // budget sized for the tail.
    expect(pool.budget(0)).toBe(5000)
    expect(pool.budget(700 * 1000)).toBe(5000 + 120)
  })

  test('the budget grows with size, so the tail is not judged by the median', () => {
    const pool = makePool(dir, { hydrateTimeoutPerMiBMs: 120 })
    const mib = 1024 * 1024
    expect(pool.budget(100 * mib)).toBe(5000 + 100 * 120)
    expect(pool.budget(900 * mib)).toBe(5000 + 900 * 120)
    expect(pool.budget(900 * mib)).toBeGreaterThan(pool.budget(100 * mib))
  })

  test('the largest archive in production gets minutes, not the flat 60s', () => {
    // 1.85 GB is a real project. Under the old flat timeout its hydrate had
    // exactly the same deadline as a 0.7 MB one, and hydrate is fail-closed —
    // so falling short means the project cannot open at all.
    const pool = makePool(dir, { hydrateTimeoutMs: 60_000, hydrateTimeoutPerMiBMs: 120 })
    const budget = pool.budget(1847 * 1024 * 1024)
    expect(budget).toBeGreaterThan(4 * 60_000)
    // Still bounded: a hung guest must not pin the assign indefinitely.
    expect(budget).toBeLessThan(15 * 60_000)
  })

  test('setting the per-MiB term to zero restores the old flat behaviour', () => {
    // The escape hatch has to actually work: an operator who sets
    // METAL_HYDRATE_TIMEOUT_PER_MIB_MS=0 gets exactly the previous semantics.
    const pool = makePool(dir, { hydrateTimeoutPerMiBMs: 0 })
    expect(pool.budget(900 * 1024 * 1024)).toBe(5000)
  })

  test('the shipped budget survives the slow patches the object store actually has', () => {
    // Pull throughput is bimodal, not merely variable: repeated pulls of one
    // object measured 28.7, 3.0, 3.0 and 32 MB/s. The budget is only useful if
    // it covers the slow mode, because hydrate is fail-closed — the old
    // 120 ms/MiB assumed 8.3 MiB/s and turned a 3 MB/s patch into a project
    // that would not open.
    const pool = makePool(dir, { hydrateTimeoutMs: 60_000, hydrateTimeoutPerMiBMs: 400 })
    const mib = 1024 * 1024
    const atThreeMbPerSec = (bytes: number) => (bytes / (3 * 1000 * 1000)) * 1000

    for (const sizeMib of [300, 700, 1200, 1847]) {
      expect(pool.budget(sizeMib * mib)).toBeGreaterThan(atThreeMbPerSec(sizeMib * mib))
    }
  })

  test('the budget never exceeds the ceiling the guest clamps itself to', () => {
    // The guest gives up at 30 minutes regardless of what it is told, so a
    // larger host deadline only means waiting past an answer already decided.
    const pool = makePool(dir, { hydrateTimeoutMs: 60_000, hydrateTimeoutPerMiBMs: 400 })
    expect(pool.budget(100 * 1024 * 1024 * 1024)).toBe(30 * 60_000)
    // ...and the cap does not distort sizes below it.
    expect(pool.budget(500 * 1024 * 1024)).toBe(60_000 + 500 * 400)
  })
})
