// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — encrypted home-directory durability wiring.
 *
 * The bytes are ciphertext the host cannot read, so what is under test is the
 * same thing pool-data.test.ts covers for the database: which lineage the pool
 * claims, and that a VM which could not restore the home never gets to write
 * over it. End-to-end behaviour is in pool-home-state.e2e.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { M, metrics } from './metrics'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { DataLineage, DataWriteOutcome } from './project-data-archive'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; opts: { lineage: DataLineage; preserveOnRefusal?: boolean } }> = []
  outcome: DataWriteOutcome = { status: 'written', etag: '"home-2"' }

  protected override async uploadHomeGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
  ): Promise<DataWriteOutcome> {
    this.uploads.push({ projectId, bytes, opts })
    return this.outcome
  }

  exportHome(token?: string, knownTag?: string) {
    return (this as any).fetchHomeExport(HANDLE, token, knownTag)
  }

  add(projectId: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = { projectId, handle: HANDLE, assignedAt: Date.now(), lastTouchedAt: Date.now(), runtimeToken: 'tok', ...extra } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

function makePool(dir: string): TestPool {
  const cfg = { ...config, work: dir, snapDir: join(dir, 'snap'), runDir: join(dir, 'run'), hydrateTimeoutMs: 5000 } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  return new TestPool({ procCount: () => 0 } as unknown as FirecrackerVMManager, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

type Call = { url: string; headers: Record<string, string> }

function guestResponds(make: () => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
    return make()
  }) as any
  return calls
}

const blob = () => new Response(new Uint8Array([0x53, 0x48, 0x47, 0x48, 1]), { status: 200, headers: { ETag: '"tag-a"' } })

describe('pool home-state durability', () => {
  let dir: string
  let pool: TestPool
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-home-'))
    pool = makePool(dir)
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  describe('fetchHomeExport', () => {
    test('maps every guest answer, and forwards the token and the known tag', async () => {
      const calls = guestResponds(blob)
      const got = await pool.exportHome('tok', '"tag-0"')
      expect(got).toMatchObject({ tag: '"tag-a"' })
      expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/export-home')
      expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'If-None-Match': '"tag-0"' })

      for (const [status, want] of [[304, 'unchanged'], [204, null], [404, 'unsupported'], [413, 'too-large']] as const) {
        guestResponds(() => new Response(null, { status }))
        expect(await pool.exportHome('tok')).toBe(want)
      }
      guestResponds(() => new Response('boom', { status: 500 }))
      await expect(pool.exportHome('tok')).rejects.toThrow(/export-home failed \(500\)/)
    })
  })

  describe('lineage claimed on write', () => {
    test('a VM that found no archive may only create one', async () => {
      guestResponds(blob)
      expect(await pool.saveHomeStateToStore(pool.add('p1'))).toBe(true)
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'create-only' })
    })

    test('a restored VM descends from the archive it restored, then from its own writes', async () => {
      guestResponds(blob)
      const a = pool.add('p1', { homeParentEtag: '"home-1"' })
      await pool.saveHomeStateToStore(a)
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'descends', etag: '"home-1"' })
      expect(a.homeParentEtag).toBe('"home-2"')
    })

    test('an untrusted VM never exports periodically, and its final export is quarantined, not written', async () => {
      const calls = guestResponds(blob)
      const a = pool.add('p1', { homeParentEtag: '"home-1"', homeUntrustedReason: 'hydrate failed' })
      expect(await pool.saveHomeStateToStore(a)).toBe(false)
      expect(calls).toHaveLength(0)

      pool.outcome = { status: 'refused', reason: 'untrusted', quarantineKey: 'conflict/p1/x-home.enc' }
      expect(await pool.saveHomeStateToStore(a, { final: true })).toBe(false)
      expect(pool.uploads[0].opts).toEqual({ lineage: { kind: 'untrusted', reason: 'hydrate failed' }, preserveOnRefusal: true })
    })

    test('a conflict distrusts the VM for the rest of its life', async () => {
      const calls = guestResponds(blob)
      const a = pool.add('p1', { homeParentEtag: '"home-1"' })
      pool.outcome = { status: 'conflict', reason: 'lineage', quarantineKey: null }
      const before = metrics.snapshot().counters[M.homeConflict] ?? 0
      expect(await pool.saveHomeStateToStore(a)).toBe(false)
      expect(a.homeUntrustedReason).toMatch(/no longer matches/)
      expect((metrics.snapshot().counters[M.homeConflict] ?? 0) - before).toBe(1)

      expect(await pool.saveHomeStateToStore(a)).toBe(false)
      expect(calls).toHaveLength(1)
    })
  })

  describe('change detection and skips', () => {
    test('the tag of the last successful write is sent next time, so an idle home is a 304', async () => {
      const first = guestResponds(blob)
      const a = pool.add('p1')
      await pool.saveHomeStateToStore(a)
      expect(first[0].headers['If-None-Match']).toBeUndefined()
      const second = guestResponds(() => new Response(null, { status: 304 }))
      expect(await pool.saveHomeStateToStore(a)).toBe(false)
      expect(second[0].headers['If-None-Match']).toBe('"tag-a"')
      expect(pool.uploads).toHaveLength(1)
    })

    test('a failed write does not advance the tag, so the same bytes are offered again', async () => {
      const calls = guestResponds(blob)
      const a = pool.add('p1')
      pool.outcome = { status: 'too-large', bytes: 99, limit: 1 }
      await pool.saveHomeStateToStore(a)
      await pool.saveHomeStateToStore(a)
      expect(calls[1].headers['If-None-Match']).toBeUndefined()
    })

    test('a guest without home support is asked once, then never again', async () => {
      const calls = guestResponds(() => new Response(null, { status: 404 }))
      const a = pool.add('p1')
      expect(await pool.exportAllHomeState()).toBe(0)
      expect(a.homeExportUnsupported).toBe(true)
      await pool.exportAllHomeState()
      await pool.saveHomeStateToStore(a, { final: true })
      expect(calls).toHaveLength(1)
    })

    test('workspace runtimes and published sites never carry a home', async () => {
      const calls = guestResponds(blob)
      pool.add('ws:abc')
      pool.add('p-pub', { publishedSubdomain: 'site' } as Partial<AssignedVm>)
      expect(await pool.exportAllHomeState()).toBe(0)
      expect(calls).toHaveLength(0)
    })

    test('one failing guest does not stop the sweep', async () => {
      let n = 0
      globalThis.fetch = mock(async () => (n++ === 0 ? new Response('boom', { status: 500 }) : blob())) as any
      const a = pool.add('p1')
      pool.add('p2')
      expect(await pool.exportAllHomeState()).toBe(1)
      expect(a.homeExportFailures).toBe(1)
    })
  })
})
