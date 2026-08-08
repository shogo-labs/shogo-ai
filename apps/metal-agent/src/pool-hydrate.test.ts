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
 * (via the `fetchArchive` seam) and a stubbed global `fetch`, so no real S3 /
 * Firecracker host is needed. The resume path is covered by construction:
 * `hydrateFromBackup` is only called from the cold `assign()` branch, never from
 * `resume()`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

/** MetalWarmPool subclass exposing the private hydrate + an injectable archive. */
class TestPool extends MetalWarmPool {
  archive: Uint8Array | null = null
  etag: string | null = null
  override fetchArchive(_projectId: string): Promise<import('./workspace-archive').WorkspaceArchive | null> {
    return Promise.resolve(this.archive ? { bytes: this.archive, etag: this.etag } : null)
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

  test('streams the durable archive to the guest /pool/hydrate with the runtime token and returns its lineage etag', async () => {
    const pool = makePool(dir)
    pool.archive = new Uint8Array([1, 2, 3, 4])
    pool.etag = '"abc123"'

    const calls: Array<{ url: string; init: any; sent: Uint8Array }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      // The body is a stream now (see the chunked-body suite below), so read it
      // back to assert the guest receives the archive byte for byte.
      const sent = new Uint8Array(await new Response(init.body).arrayBuffer())
      calls.push({ url: String(url), init, sent })
      return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
    }) as any

    const result = await pool.hydrate('p1', { RUNTIME_AUTH_SECRET: 'secret-token' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/hydrate')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
    expect(calls[0].sent).toEqual(pool.archive!)
    // The returned lineage anchors the workspace to the backup we applied, so a
    // later suspend can safely overwrite exactly that object.
    expect(result).toEqual({ hydrated: true, parentEtag: '"abc123"' })
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

    await expect(pool.hydrate('p2', { RUNTIME_AUTH_SECRET: 'tok' })).rejects.toThrow(/\/pool\/hydrate failed \(500\)/)
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

  test('hydrate sends a stream with duplex:half and no Content-Length', async () => {
    // THE GUEST-OOM REGRESSION. Bun.serve buffers a request body whole when
    // Content-Length is set, whatever the handler does with it: measured at
    // +1978 MB of RSS for a 1 GB body versus +91 MB chunked. Passing a
    // Uint8Array sets that header, and a 2 GB hydrate then panicked the guest
    // kernel ("Out of memory and no killable processes") before its streaming
    // handler saw a byte. Passing a Uint8Array here again would look perfectly
    // reasonable in review, so it is pinned.
    const pool = makePool(dir)
    pool.archive = new Uint8Array(4 * 1024 * 1024)

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
})
