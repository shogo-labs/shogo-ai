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
  override fetchArchive(_projectId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.archive)
  }
  hydrate(projectId: string, env: Record<string, string>) {
    // hydrateFromBackup is private; reach it through the instance.
    return (this as any).hydrateFromBackup(projectId, HANDLE, env)
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
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

  test('streams the durable archive to the guest /pool/hydrate with the runtime token', async () => {
    const pool = makePool(dir)
    pool.archive = new Uint8Array([1, 2, 3, 4])

    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
    }) as any

    await pool.hydrate('p1', { RUNTIME_AUTH_SECRET: 'secret-token' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/hydrate')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
    expect(calls[0].init.body).toEqual(pool.archive)
  })

  test('is a no-op when the project has no durable backup (new project)', async () => {
    const pool = makePool(dir)
    pool.archive = null // no backup

    let called = false
    globalThis.fetch = mock(async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as any

    await pool.hydrate('brand-new', { RUNTIME_AUTH_SECRET: 'tok' })
    expect(called).toBe(false)
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
