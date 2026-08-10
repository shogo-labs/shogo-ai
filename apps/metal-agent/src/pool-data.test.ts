// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — writable-state durability wiring (database + uploads).
 *
 * Companion to pool-backup.test.ts, which covers the SOURCE archive. Source
 * durability was never enough: a snapshot is not a backup, so when a
 * golden-rootfs rebuild invalidated every snapshot at once, the cold boot that
 * followed restored code over an empty database and the user's data was gone.
 *
 * The property under test throughout is that a workspace may only write the
 * durable archive it can prove it descends from. The guard itself lives in the
 * storage layer (a conditional PUT); what these cover is the pool deciding
 * WHICH lineage to claim, and never upgrading a bad one into a good one.
 *
 * These drive the seams directly (`fetchDataExport` over a stubbed global
 * `fetch`, `uploadDataGuarded` recorded), so no real guest / S3 / Firecracker
 * is needed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import { M, metrics } from './metrics'
import type { DataLineage, DataWriteOutcome } from './project-data-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

interface RecordedUpload {
  projectId: string
  bytes: Uint8Array
  opts: { lineage: DataLineage; preserveOnRefusal?: boolean }
}

class TestPool extends MetalWarmPool {
  uploads: RecordedUpload[] = []
  outcome: DataWriteOutcome = { status: 'written', etag: '"new"' }
  uploadDelayMs = 0

  protected override async uploadDataGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
  ): Promise<DataWriteOutcome> {
    this.uploads.push({ projectId, bytes, opts })
    if (this.uploadDelayMs) await Bun.sleep(this.uploadDelayMs)
    return this.outcome
  }

  exportData(token?: string, knownTag?: string) {
    return (this as any).fetchDataExport(HANDLE, token, knownTag)
  }

  add(projectId: string, extra: Partial<AssignedVm> = {}, handle = HANDLE): AssignedVm {
    const a = {
      projectId,
      handle,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  save(projectId: string, opts: { final?: boolean } = {}, extra: Partial<AssignedVm> = {}) {
    if (!(this as any).assigned.has(projectId)) this.add(projectId, extra)
    return this.saveProjectDataToStore((this as any).assigned.get(projectId), opts)
  }

  assignedEntry(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }

  snapshotEtagFor(a: AssignedVm): string | undefined {
    return (this as any).trustedDataEtag(a)
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

/** A guest that always has writable state to hand over. */
function guestReturns(body: Uint8Array, etag?: string): void {
  globalThis.fetch = mock(
    async () =>
      new Response(body, { status: 200, headers: etag ? { ETag: etag } : undefined }),
  ) as any
}

describe('pool writable-state durability', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-data-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  describe('fetchDataExport', () => {
    test('POSTs to the guest with the runtime token and returns bytes + tag', async () => {
      const pool = makePool(dir)
      const calls: Array<{ url: string; init: any }> = []
      globalThis.fetch = mock(async (url: any, init: any) => {
        calls.push({ url: String(url), init })
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { ETag: 'tag-1' },
        })
      }) as any

      const out = await pool.exportData('secret-token')
      expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/export-data')
      expect(calls[0].init.method).toBe('POST')
      expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
      expect(out).toEqual({ bytes: new Uint8Array([1, 2, 3]), tag: 'tag-1' })
    })

    test('echoes a known tag back so the guest can answer 304', async () => {
      const pool = makePool(dir)
      const calls: Array<any> = []
      globalThis.fetch = mock(async (_url: any, init: any) => {
        calls.push(init)
        return new Response(null, { status: 304 })
      }) as any

      expect(await pool.exportData('tok', 'tag-7')).toBe('unchanged')
      expect(calls[0].headers['If-None-Match']).toBe('tag-7')
    })

    test('204 means the project has no writable state at all', async () => {
      const pool = makePool(dir)
      globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any
      expect(await pool.exportData('tok')).toBeNull()
    })

    test('throws when the guest rejects', async () => {
      const pool = makePool(dir)
      globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any
      await expect(pool.exportData('tok')).rejects.toThrow(/\/pool\/export-data failed \(500\)/)
    })
  })

  describe('lineage claimed on write', () => {
    test('a hydrated workspace claims descent from the archive it came from', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([5, 6, 7, 8]))

      await pool.save('p1', {}, { dataParentEtag: '"parent"' })
      expect(pool.uploads).toHaveLength(1)
      expect(pool.uploads[0].bytes).toEqual(new Uint8Array([5, 6, 7, 8]))
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'descends', etag: '"parent"' })
    })

    test('a workspace with no lineage may only create, never overwrite', async () => {
      // Covers both a brand-new project and a VM adopted across an agent
      // restart from before lineage tracking. Neither can prove descent, so
      // neither is allowed to replace an existing archive.
      const pool = makePool(dir)
      guestReturns(new Uint8Array([1]))

      await pool.save('p1')
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'create-only' })
    })

    test('a failed hydrate makes the workspace untrusted, not merely unknown', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([1]))

      await pool.save('p1', { final: true }, { dataUntrustedReason: 'hydrate failed' })
      expect(pool.uploads[0].opts.lineage).toEqual({
        kind: 'untrusted',
        reason: 'hydrate failed',
      })
    })

    test('untrusted beats a stale ETag — a distrusted VM cannot claim descent', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([1]))

      await pool.save(
        'p1',
        { final: true },
        { dataParentEtag: '"stale"', dataUntrustedReason: 'lineage diverged' },
      )
      expect(pool.uploads[0].opts.lineage.kind).toBe('untrusted')
    })
  })

  describe('untrusted workspaces', () => {
    test('are not even asked for an export on the periodic cycle', async () => {
      // Packing and shipping a database we already know we will refuse is pure
      // waste — and on a busy host it is waste repeated every interval.
      const pool = makePool(dir)
      const fetchMock = mock(async () => new Response(new Uint8Array([1]), { status: 200 }))
      globalThis.fetch = fetchMock as any

      const before = metrics.getCounter(M.dataRefused)
      expect(await pool.save('p1', {}, { dataUntrustedReason: 'hydrate failed' })).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(pool.uploads).toHaveLength(0)
      expect(metrics.getCounter(M.dataRefused)).toBe(before + 1)
    })

    test('still export on suspend, so the bytes can be preserved for recovery', async () => {
      // The final export is the only one worth keeping: it holds whatever the
      // user actually did in this VM, which nothing else has a copy of.
      const pool = makePool(dir)
      pool.outcome = { status: 'refused', reason: 'hydrate failed', quarantineKey: 'conflict/p1/x' }
      guestReturns(new Uint8Array([9, 9]))

      expect(await pool.save('p1', { final: true }, { dataUntrustedReason: 'hydrate failed' })).toBe(
        false,
      )
      expect(pool.uploads).toHaveLength(1)
      expect(pool.uploads[0].opts.preserveOnRefusal).toBe(true)
    })

    test('periodic exports do not ask for the bytes to be preserved', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([1]))
      await pool.save('p1')
      expect(pool.uploads[0].opts.preserveOnRefusal).toBe(false)
    })
  })

  describe('outcomes', () => {
    test('a successful write re-anchors lineage from the write itself', async () => {
      // Taken from the PUT's own response rather than a follow-up HEAD, which
      // would reintroduce the read-then-write window the guard exists to close.
      const pool = makePool(dir)
      pool.outcome = { status: 'written', etag: '"fresh"' }
      guestReturns(new Uint8Array([9]))

      await pool.save('p1', {}, { dataParentEtag: '"old"' })
      expect(pool.assignedEntry('p1')!.dataParentEtag).toBe('"fresh"')
    })

    test('a conflict distrusts the VM so it stops trying every cycle', async () => {
      const pool = makePool(dir)
      pool.outcome = { status: 'conflict', quarantineKey: null, reason: 'lineage' }
      guestReturns(new Uint8Array([3, 3, 7]))

      const before = metrics.getCounter(M.dataConflict)
      expect(await pool.save('p1', {}, { dataParentEtag: '"stale"' })).toBe(false)
      expect(metrics.getCounter(M.dataConflict)).toBe(before + 1)
      expect(pool.assignedEntry('p1')!.dataUntrustedReason).toBeTruthy()

      // And the next cycle is a no-op rather than another failed upload.
      const uploadsAfterFirst = pool.uploads.length
      expect(await pool.save('p1')).toBe(false)
      expect(pool.uploads).toHaveLength(uploadsAfterFirst)
    })

    test('a create-only writer that lost the race is distrusted, not retried', async () => {
      const pool = makePool(dir)
      pool.outcome = { status: 'conflict', quarantineKey: null, reason: 'raced-create' }
      guestReturns(new Uint8Array([4]))

      expect(await pool.save('p1')).toBe(false)
      expect(pool.assignedEntry('p1')!.dataUntrustedReason).toContain('cannot prove it descends')
    })

    test('a refusal is metered and writes nothing', async () => {
      const pool = makePool(dir)
      pool.outcome = { status: 'refused', reason: 'hydrate failed', quarantineKey: null }
      guestReturns(new Uint8Array([1]))

      const before = metrics.getCounter(M.dataRefused)
      expect(await pool.save('p1', { final: true }, { dataUntrustedReason: 'hydrate failed' })).toBe(
        false,
      )
      expect(metrics.getCounter(M.dataRefused)).toBe(before + 1)
      expect(pool.assignedEntry('p1')!.dataParentEtag).toBeUndefined()
    })

    test('an oversized archive is metered and not persisted', async () => {
      const pool = makePool(dir)
      pool.outcome = {
        status: 'too-large',
        bytes: 2 * 1024 * 1024 * 1024,
        limit: 1024 * 1024 * 1024,
      }
      guestReturns(new Uint8Array([1]))

      const before = metrics.getCounter(M.dataTooLarge)
      expect(await pool.save('p1')).toBe(false)
      expect(metrics.getCounter(M.dataTooLarge)).toBe(before + 1)
      expect(pool.assignedEntry('p1')!.dataParentEtag).toBeUndefined()
    })

    test('a project with no writable state uploads nothing', async () => {
      const pool = makePool(dir)
      globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any
      expect(await pool.save('p1')).toBe(false)
      expect(pool.uploads).toHaveLength(0)
    })
  })

  describe('unchanged state', () => {
    test('is skipped without uploading, and metered', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([1, 1, 1]), 'tag-a')
      expect(await pool.save('p1')).toBe(true)

      globalThis.fetch = mock(async () => new Response(null, { status: 304 })) as any
      const before = metrics.getCounter(M.dataUnchanged)
      expect(await pool.save('p1')).toBe(false)
      expect(metrics.getCounter(M.dataUnchanged)).toBe(before + 1)
      expect(pool.uploads).toHaveLength(1)
    })

    test('changed state uploads again', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([1, 1, 1]), 'tag-a')
      await pool.save('p1')
      guestReturns(new Uint8Array([2, 2, 2]), 'tag-b')
      expect(await pool.save('p1')).toBe(true)
      expect(pool.uploads).toHaveLength(2)
    })
  })

  describe('concurrency', () => {
    test('the periodic exporter and suspend cannot export the same project at once', async () => {
      // Both writers would carry the SAME lineage, so whichever landed second
      // would fail its precondition and throw away the fresher database.
      const pool = makePool(dir)
      pool.uploadDelayMs = 30
      guestReturns(new Uint8Array([1]))
      pool.add('p1')

      const [a, b] = await Promise.all([pool.save('p1'), pool.save('p1', { final: true })])
      expect(pool.uploads).toHaveLength(1)
      expect(a).toBe(b)
    })
  })

  describe('snapshot lineage', () => {
    test('a trusted VM freezes its ETag into the snapshot', () => {
      const pool = makePool(dir)
      const a = pool.add('p1', { dataParentEtag: '"good"' })
      expect(pool.snapshotEtagFor(a)).toBe('"good"')
    })

    test('an untrusted VM freezes nothing, so a resume cannot inherit its claim', () => {
      // Otherwise suspend/resume would launder a distrusted database back into
      // a writer entitled to overwrite the archive.
      const pool = makePool(dir)
      const a = pool.add('p1', { dataParentEtag: '"stale"', dataUntrustedReason: 'diverged' })
      expect(pool.snapshotEtagFor(a)).toBeUndefined()
    })
  })

  describe('periodic sweep', () => {
    test('covers every live VM, not just published ones', async () => {
      const pool = makePool(dir)
      guestReturns(new Uint8Array([7]))
      for (const id of ['p1', 'p2', 'p3']) pool.add(id)

      expect(await pool.exportAllProjectData()).toBe(3)
      expect(pool.uploads.map((u) => u.projectId).sort()).toEqual(['p1', 'p2', 'p3'])
    })

    test('one project failing does not stop the rest', async () => {
      const pool = makePool(dir)
      globalThis.fetch = mock(async (url: any) =>
        String(url).includes('10.0.0.9')
          ? new Response(new Uint8Array([7]), { status: 200 })
          : new Response('boom', { status: 500 }),
      ) as any
      pool.add('p1', {}, { ...HANDLE, agentUrl: 'http://10.0.0.1:8080' })
      pool.add('p2')

      expect(await pool.exportAllProjectData()).toBe(1)
      expect(pool.uploads.map((u) => u.projectId)).toEqual(['p2'])
    })

    // Observed on staging: the VMs already running when the new agent rolled
    // out answer 404, and every one of them re-asked on every cycle — 1620
    // identical failures in six hours, which is exactly how a real failure
    // gets missed.
    test('a guest that predates the endpoint is asked once, then never again', async () => {
      const pool = makePool(dir)
      let calls = 0
      globalThis.fetch = mock(async () => {
        calls++
        return new Response('404 Not Found', { status: 404 })
      }) as any
      pool.add('old-vm')

      const before = metrics.snapshot().counters[M.dataUnsupported] ?? 0
      for (let i = 0; i < 5; i++) await pool.exportAllProjectData()

      expect(calls).toBe(1)
      expect(pool.assignedEntry('old-vm')!.dataExportUnsupported).toBe(true)
      expect((metrics.snapshot().counters[M.dataUnsupported] ?? 0) - before).toBe(1)
      expect(pool.uploads).toEqual([])
    })

    test('an unreachable guest backs off instead of retrying every cycle', async () => {
      const pool = makePool(dir)
      let calls = 0
      globalThis.fetch = mock(async () => {
        calls++
        throw new Error('Unable to connect.')
      }) as any
      const a = pool.add('dead-vm')

      await pool.exportAllProjectData()
      expect(calls).toBe(1)
      expect(a.dataExportFailures).toBe(1)
      expect(a.dataExportRetryAfter).toBeGreaterThan(Date.now())

      // Still inside the backoff window: skipped without touching the guest.
      await pool.exportAllProjectData()
      expect(calls).toBe(1)

      // Once it elapses the retry happens, and the wait grows.
      a.dataExportRetryAfter = Date.now() - 1
      await pool.exportAllProjectData()
      expect(calls).toBe(2)
      expect(a.dataExportFailures).toBe(2)
    })

    test('a guest that recovers is taken off backoff immediately', async () => {
      const pool = makePool(dir)
      let fail = true
      globalThis.fetch = mock(async () => {
        if (fail) throw new Error('Unable to connect.')
        return new Response(new Uint8Array([7]), { status: 200 })
      }) as any
      const a = pool.add('flaky')

      await pool.exportAllProjectData()
      expect(a.dataExportFailures).toBe(1)

      fail = false
      a.dataExportRetryAfter = Date.now() - 1
      expect(await pool.exportAllProjectData()).toBe(1)
      expect(a.dataExportFailures).toBe(0)
      expect(a.dataExportRetryAfter).toBeUndefined()
    })

    // An idle project answers 304, which is success even though nothing was
    // written. Treating it as a failure would slowly back off exactly the
    // projects that are behaving.
    test('an unchanged (304) project is not treated as a failure', async () => {
      const pool = makePool(dir)
      globalThis.fetch = mock(async () => new Response(null, { status: 304 })) as any
      const a = pool.add('idle', { dataParentEtag: '"e"' })
      ;(pool as any).dataTags.set('idle', 'tag-1')

      await pool.exportAllProjectData()
      await pool.exportAllProjectData()

      expect(a.dataExportFailures).toBe(0)
      expect(a.dataExportRetryAfter).toBeUndefined()
    })
  })
})
