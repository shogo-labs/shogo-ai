// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool env-refresh on resume (audit Finding 1).
 *
 * A metal resume restores a VM from a memory snapshot, which brings the guest
 * process back with the env baked at first assign. A change since then to the
 * AI-proxy URL/token, SHOGO_API_URL, or a rotated secret therefore never reaches
 * a resumed guest — it serves with stale config until a cold boot (root cause of
 * the 2026-07 "provider connection errors" incidents).
 *
 * The fix threads the current env through resume() and POSTs it to the guest's
 * /pool/refresh-env after restore. These tests pin (a) the low-level
 * refreshGuestEnv HTTP contract and (b) that resume() actually calls it with the
 * env and stamps the runtime token onto the assigned VM. Driven with fakes — no
 * real Firecracker host.
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

class TestPool extends MetalWarmPool {
  /** Reach the private refreshGuestEnv through the instance. */
  refresh(projectId: string, env: Record<string, string>) {
    return (this as any).refreshGuestEnv(HANDLE, projectId, env)
  }
  /** Seed a suspended entry so resume() takes the hot-local path. */
  seedSuspended(projectId: string) {
    ;(this as any).suspended.set(projectId, {
      projectId,
      snapshot: {
        vmId: `s-${projectId}`,
        snapshotPath: '/snap/vmstate',
        memFilePath: '/snap/mem',
        rootfs: '/snap/rootfs',
        net: {},
        vcpus: 2,
        memoryMB: 2048,
        createdAt: 0,
        bytesMem: 1,
        bytesState: 1,
        bytesRootfs: 1,
      },
      suspendedAt: 0,
      lastAccessAt: 0,
    })
  }
}

function makePool(dir: string, mgr?: Partial<FirecrackerVMManager>): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    rehydrateTimeoutMs: 5000,
    healthRetries: 1,
    healthIntervalMs: 1,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = {
    procCount: () => 0,
    restoreVM: async () => HANDLE,
    isRunning: () => true,
    stopVM: async () => {},
    ...mgr,
  } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool.refreshGuestEnv', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-refresh-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('POSTs the env to the guest /pool/refresh-env with the runtime token', async () => {
    const pool = makePool(dir)
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, changed: ['SHOGO_API_URL'] }), { status: 200 })
    }) as any

    await pool.refresh('p1', { RUNTIME_AUTH_SECRET: 'secret-token', SHOGO_API_URL: 'http://api.new' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/refresh-env')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
    const body = JSON.parse(calls[0].init.body)
    expect(body.projectId).toBe('p1')
    expect(body.env.SHOGO_API_URL).toBe('http://api.new')
  })

  test('is a no-op when there is no env to apply', async () => {
    const pool = makePool(dir)
    let called = false
    globalThis.fetch = mock(async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as any
    await pool.refresh('p1', {})
    expect(called).toBe(false)
  })

  test('tolerates a 404 from a guest that predates /pool/refresh-env', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response('not found', { status: 404 })) as any
    // Must NOT throw — old guests keep serving with their prior env.
    await pool.refresh('p1', { RUNTIME_AUTH_SECRET: 'tok' })
  })

  test('throws on a non-404 error so the caller can log it', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any
    await expect(pool.refresh('p1', { RUNTIME_AUTH_SECRET: 'tok' })).rejects.toThrow(/refresh-env 500/)
  })

  test('omits the Authorization header when no runtime token is present', async () => {
    const pool = makePool(dir)
    const inits: any[] = []
    globalThis.fetch = mock(async (_u: any, init: any) => {
      inits.push(init)
      return new Response('{}', { status: 200 })
    }) as any
    await pool.refresh('p1', { SHOGO_API_URL: 'http://x' })
    expect(inits[0].headers.Authorization).toBeUndefined()
  })
})

describe('pool.resume re-applies env', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-resume-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('resume() calls /pool/refresh-env with the passed env and stamps the runtime token', async () => {
    const pool = makePool(dir)
    pool.seedSuspended('p1')
    // Stub the health + rehydrate seams so resume() reaches the refresh step.
    ;(pool as any).waitForHealth = async () => 1
    ;(pool as any).callGuestHook = async () => true

    const refreshCalls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      refreshCalls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, changed: ['SHOGO_API_URL'] }), { status: 200 })
    }) as any

    const res = await pool.resume('p1', {
      RUNTIME_AUTH_SECRET: 'tok-123',
      SHOGO_API_URL: 'http://api.fresh',
    })

    expect(res).not.toBeNull()
    // The restored VM carries the runtime token so /pool/export + adopt-on-restart keep working.
    expect(res!.assigned.runtimeToken).toBe('tok-123')

    // Exactly one refresh-env call, with the fresh env + auth.
    const refresh = refreshCalls.find((c) => c.url.endsWith('/pool/refresh-env'))
    expect(refresh).toBeDefined()
    expect(refresh!.init.headers.Authorization).toBe('Bearer tok-123')
    const body = JSON.parse(refresh!.init.body)
    expect(body.projectId).toBe('p1')
    expect(body.env.SHOGO_API_URL).toBe('http://api.fresh')
  })

  test('a refresh failure does not fail the resume (best-effort)', async () => {
    const pool = makePool(dir)
    pool.seedSuspended('p1')
    ;(pool as any).waitForHealth = async () => 1
    ;(pool as any).callGuestHook = async () => true

    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any

    // resume() catches the refresh error internally — it must still return the VM.
    const res = await pool.resume('p1', { RUNTIME_AUTH_SECRET: 'tok' })
    expect(res).not.toBeNull()
    expect(res!.assigned.projectId).toBe('p1')
  })
})
