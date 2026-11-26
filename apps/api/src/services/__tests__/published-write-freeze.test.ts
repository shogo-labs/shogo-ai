// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * §G3: no lost writes at the SQLite → Postgres cutover.
 *
 * The archive a move seeds from is the one the pod last uploaded — up to 30 s old
 * by default — so the freeze has to put up maintenance, make the pod flush, and
 * wait for a fresh archive before anything reads it. And it has to come back down
 * on every path: a failed move must leave the SQLite revision serving.
 */

import { describe, expect, it } from 'bun:test'
import {
  FLUSH_TIMEOUT_MS,
  PERIODIC_ARCHIVE_INTERVAL_MS,
  createWriteFreeze,
  flushResultFromResponse,
  type FlushResult,
  type WriteFreezeDeps,
} from '../published-write-freeze'

const T0 = 1_000_000

function deps(overrides: Partial<WriteFreezeDeps> = {}): {
  deps: WriteFreezeDeps
  log: string[]
  maintenance: Array<{ on: boolean; detail?: string | null }>
  clock: { now: number }
} {
  const log: string[] = []
  const maintenance: Array<{ on: boolean; detail?: string | null }> = []
  const clock = { now: T0 }
  const base: WriteFreezeDeps = {
    async setMaintenance(on, detail) {
      maintenance.push({ on, detail })
    },
    async requestFlush(): Promise<FlushResult> {
      return { ok: true, flushed: true, unchanged: false, warm: true }
    },
    async headArchive() {
      return { lastModifiedMs: clock.now, bytes: 1024 }
    },
    now: () => clock.now,
    async sleep(ms) {
      // Time only moves when the freeze waits, so a poll loop is bounded here.
      clock.now += ms
    },
    log: (message) => log.push(message),
    ...overrides,
  }
  return { deps: base, log, maintenance, clock }
}

function freeze(d: WriteFreezeDeps) {
  return createWriteFreeze(
    {
      projectId: '5925615d-0157-44d3-a114-41b35a14785e',
      subdomain: 'kif-crm',
      environmentId: 'env-1',
      environmentName: 'production',
    },
    d,
  )
}

describe('createWriteFreeze', () => {
  it('puts maintenance up before it asks for a flush', async () => {
    const order: string[] = []
    const built = deps({
      async setMaintenance(on) {
        order.push(`maintenance:${on}`)
      },
      async requestFlush() {
        order.push('flush')
        return { ok: true, flushed: true, unchanged: false, warm: true }
      },
      async headArchive() {
        order.push('head')
        return { lastModifiedMs: T0, bytes: 1 }
      },
    })
    const handle = freeze(built.deps)
    expect(await handle.begin()).toEqual({ ok: true })
    expect(order[0]).toBe('maintenance:true')
    expect(order[1]).toBe('flush')
    expect(handle.begun).toBe(true)
  })

  it('accepts an archive that already matches the pod, without waiting', async () => {
    let heads = 0
    const built = deps({
      async requestFlush() {
        return { ok: true, flushed: false, unchanged: true, warm: true }
      },
      async headArchive() {
        heads++
        return null
      },
    })
    const handle = freeze(built.deps)
    expect(await handle.begin()).toEqual({ ok: true })
    expect(heads).toBe(0)
  })

  it('accepts nothing while nothing is serving: no pod, no pending writes', async () => {
    const built = deps({
      async requestFlush() {
        return { ok: true, flushed: false, unchanged: false, warm: false }
      },
    })
    expect(await freeze(built.deps).begin()).toEqual({ ok: true })
  })

  it('waits for the archive to be rewritten after the flush', async () => {
    let polls = 0
    const built = deps({
      // The flush lands on the third poll.
      async headArchive() {
        polls++
        const fresh = polls >= 3
        return { lastModifiedMs: fresh ? built.clock.now : T0 - 60_000, bytes: 1 }
      },
    })
    expect(await freeze(built.deps).begin()).toEqual({ ok: true })
    expect(polls).toBe(3)
    expect(built.log.join('\n')).toContain('Final flush landed')
  })

  it('refuses the move when the pod cannot flush, so no write is silently dropped', async () => {
    const built = deps({
      async requestFlush() {
        return { ok: false, flushed: false, unchanged: false, warm: true, detail: 'HTTP 503' }
      },
    })
    const result = await freeze(built.deps).begin()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('write_freeze_failed')
      expect(result.message).toContain('HTTP 503')
      expect(result.message).toContain('still serving on SQLite')
    }
  })

  it('gives up after the flush timeout rather than seeding a stale archive', async () => {
    const built = deps({
      async headArchive() {
        return { lastModifiedMs: T0 - 600_000, bytes: 1 }
      },
    })
    const result = await freeze(built.deps).begin()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(`${Math.round(FLUSH_TIMEOUT_MS / 1000)}s`)
  })

  it('lifts maintenance on failure with the reason, and on success as live', async () => {
    const failed = deps({
      async requestFlush() {
        return { ok: false, flushed: false, unchanged: false, warm: true, detail: 'boom' }
      },
    })
    const handle = freeze(failed.deps)
    const begun = await handle.begin()
    expect(begun.ok).toBe(false)
    await handle.end('write_freeze_failed: boom')
    expect(failed.maintenance).toEqual([
      { on: true, detail: null },
      { on: false, detail: 'write_freeze_failed: boom' },
    ])

    const ok = deps({})
    const okHandle = freeze(ok.deps)
    await okHandle.begin()
    ok.clock.now += 4_000
    await okHandle.end(null)
    expect(ok.maintenance).toEqual([
      { on: true, detail: null },
      { on: false, detail: null },
    ])
    // The write-freeze length is reported, so a publish can log it (§G3).
    expect(okHandle.frozenMs).toBe(4_000)
  })

  it('is a no-op when it never began, and never lifts twice', async () => {
    const built = deps({})
    const handle = freeze(built.deps)
    await handle.end(null)
    expect(built.maintenance).toEqual([])

    await handle.begin()
    await handle.end(null)
    await handle.end(null)
    expect(built.maintenance).toHaveLength(2)
  })
})

/**
 * A live pod published before §G has no `/agent/published-data/flush`, so it
 * answered 404 and the first KIF cutover was refused — correctly, but forever,
 * because that pod can never grow the endpoint. It does still upload to the same
 * archive on `PUBLISHED_DATA_SYNC_INTERVAL`, and maintenance has already stopped
 * writes, so waiting for that upload is lossless.
 */
describe('cutting over from a pod older than the flush endpoint', () => {
  it('treats 404 and 405 as "flush on your own timer", not as a failure', () => {
    for (const status of [404, 405]) {
      const result = flushResultFromResponse(status, {})
      expect(result.ok).toBe(true)
      expect(result.unsupported).toBe(true)
      expect(result.warm).toBe(true)
      expect(result.flushed).toBe(false)
    }
  })

  it('still fails on a real flush error and reports its reason', () => {
    const result = flushResultFromResponse(503, { message: 'upstream connect error' })
    expect(result.ok).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.detail).toBe('upstream connect error')

    expect(flushResultFromResponse(500, { error: 'flush_failed' }).detail).toBe('flush_failed')
    expect(flushResultFromResponse(418, {}).detail).toBe('HTTP 418')
  })

  it('reads a normal answer as before', () => {
    expect(flushResultFromResponse(200, { ok: true, flushed: true })).toEqual({
      ok: true,
      flushed: true,
      unchanged: false,
      warm: true,
    })
    expect(flushResultFromResponse(200, { ok: true, unchanged: true }).unchanged).toBe(true)
  })

  it('waits for the old pod’s periodic upload and then goes ahead', async () => {
    let polls = 0
    const built = deps({
      async requestFlush() {
        return { ok: true, flushed: false, unchanged: false, warm: true, unsupported: true }
      },
      // The 30 s timer uploads on the 31st poll; nothing is fresh before that.
      async headArchive() {
        polls++
        const fresh = polls >= 31
        return { lastModifiedMs: fresh ? built.clock.now : T0 - 60_000, bytes: 4096 }
      },
    })
    const handle = freeze(built.deps)
    expect(await handle.begin()).toEqual({ ok: true })
    expect(polls).toBe(31)
    expect(built.log.join('\n')).toContain('predates the flush endpoint')
    expect(built.log.join('\n')).toContain('Final flush landed')
  })

  it('gives the old pod a whole interval more than the flush budget', async () => {
    // A large database's snapshot can take longer than FLUSH_TIMEOUT_MS to
    // appear; the extended budget is what lets it. Fresh only after 90 s, which
    // the plain 60 s flush budget would have refused.
    const built = deps({
      async requestFlush() {
        return { ok: true, flushed: false, unchanged: false, warm: true, unsupported: true }
      },
      async headArchive() {
        const fresh = built.clock.now - T0 >= 90_000
        return { lastModifiedMs: fresh ? built.clock.now : T0 - 60_000, bytes: 1 }
      },
    })
    const handle = freeze(built.deps)
    expect(await handle.begin()).toEqual({ ok: true })
    expect(built.clock.now - T0).toBeGreaterThanOrEqual(90_000)
    expect(PERIODIC_ARCHIVE_INTERVAL_MS).toBe(30_000)
  })

  it('refuses the move when an old pod never uploads, and lifts maintenance', async () => {
    const built = deps({
      async requestFlush() {
        return { ok: true, flushed: false, unchanged: false, warm: true, unsupported: true }
      },
      async headArchive() {
        return { lastModifiedMs: T0 - 3_600_000, bytes: 4096 }
      },
    })
    const handle = freeze(built.deps)
    const result = await handle.begin()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('write_freeze_failed')
      expect(result.message).toContain('predates the flush endpoint')
      expect(result.message).toContain('still serving on SQLite')
    }
    await handle.end('write_freeze_failed: no periodic upload')
    expect(built.maintenance.map((m) => m.on)).toEqual([true, false])
  })
})
