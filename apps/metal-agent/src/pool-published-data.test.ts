// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — server-backed published writable-state durability.
 *
 * The metal analog of the Knative runtime's PublishedDataSync, done host-side
 * because the guest holds no S3 creds:
 *   - export: pull the guest's writable-state tar (/agent/published-data-archive)
 *     and upload it to `{subdomain}/data.tar.gz` in the published-data bucket;
 *   - the periodic exporter flushes every live published VM.
 *
 * We drive the seams directly (`fetchPublishedExport` over a stubbed global
 * `fetch`, `uploadPublishedData` recorded) so no real guest / S3 / Firecracker
 * is needed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploads: Array<{ subdomain: string; bytes: Uint8Array }> = []
  uploadResult = true
  protected override uploadPublishedData(subdomain: string, bytes: Uint8Array): Promise<boolean> {
    this.uploads.push({ subdomain, bytes })
    return Promise.resolve(this.uploadResult)
  }
  fetchExport(token?: string) {
    return (this as any).fetchPublishedExport(HANDLE, token) as Promise<Uint8Array | null>
  }
  addAssigned(a: Partial<AssignedVm> & { projectId: string }) {
    ;(this as any).assigned.set(a.projectId, {
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      ...a,
    })
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

const b64 = (bytes: number[]) => Buffer.from(new Uint8Array(bytes)).toString('base64')

describe('pool published-data durability (host-side export)', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-pubdata-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('fetchPublishedExport GETs /agent/published-data-archive with the runtime token', async () => {
    const pool = makePool(dir)
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ archive: b64([1, 2, 3]) }), { status: 200 })
    }) as any

    const bytes = await pool.fetchExport('secret-token')
    expect(calls[0].url).toBe('http://10.0.0.9:8080/agent/published-data-archive')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.headers['x-runtime-token']).toBe('secret-token')
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('fetchPublishedExport returns null on 404 (no writable state yet)', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as any
    expect(await pool.fetchExport('tok')).toBeNull()
  })

  test('exportPublishedData uploads the packed writable state under the subdomain', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ archive: b64([5, 6, 7, 8]) }), { status: 200 })) as any

    const ok = await pool.exportPublishedData({
      projectId: 'p1',
      handle: HANDLE,
      assignedAt: 0,
      lastTouchedAt: 0,
      publishedSubdomain: 'my-site',
      runtimeToken: 'tok',
    } as AssignedVm)
    expect(ok).toBe(true)
    expect(pool.uploads).toHaveLength(1)
    expect(pool.uploads[0].subdomain).toBe('my-site')
    expect(pool.uploads[0].bytes).toEqual(new Uint8Array([5, 6, 7, 8]))
  })

  test('exportPublishedData is a no-op for a non-published VM', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ archive: b64([9]) }), { status: 200 })) as any
    const ok = await pool.exportPublishedData({
      projectId: 'p1',
      handle: HANDLE,
      assignedAt: 0,
      lastTouchedAt: 0,
    } as AssignedVm)
    expect(ok).toBe(false)
    expect(pool.uploads).toHaveLength(0)
  })

  test('exportAllPublishedData flushes only the live published VMs', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ archive: b64([1]) }), { status: 200 })) as any
    pool.addAssigned({ projectId: 'dev', runtimeToken: 't' }) // not published
    pool.addAssigned({ projectId: 'published:p1', publishedSubdomain: 'site-a', runtimeToken: 't' })
    pool.addAssigned({ projectId: 'published:p2', publishedSubdomain: 'site-b', runtimeToken: 't' })

    const n = await pool.exportAllPublishedData()
    expect(n).toBe(2)
    expect(pool.uploads.map((u) => u.subdomain).sort()).toEqual(['site-a', 'site-b'])
  })
})
