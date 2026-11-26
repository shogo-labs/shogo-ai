// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the pure rootfs-rollback module (SHO-552):
 * rollback decision logic, ColdBootLedger, bad-list helpers, and marker I/O.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BAD_CAP,
  BAD_MARKER,
  ColdBootLedger,
  DEFAULT_MIN_FAILURES,
  DEFAULT_ROLLBACK_RATE,
  DEFAULT_WATCH_MS,
  PREV_MARKER,
  WATCH_MARKER,
  addBadRootfs,
  clearPrevious,
  clearWatch,
  findBadRootfs,
  isPreviousImageOnDisk,
  latestBadRootfs,
  readBadList,
  readPrevious,
  readWatch,
  rollbackDecision,
  writeBadList,
  writePrevious,
  writeWatch,
  type BadRootfs,
  type RootfsPrevious,
  type RootfsWatch,
} from './rootfs-rollback'
import { existsSync, writeFileSync } from 'fs'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rootfs-rollback-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// rollbackDecision
// ---------------------------------------------------------------------------

describe('rollbackDecision', () => {
  const BASE_WATCH: RootfsWatch = {
    version: 'v1',
    prevVersion: 'v0',
    activatedAt: 1000,
    until: 1000 + DEFAULT_WATCH_MS,
  }

  test('no watch → ok', () => {
    expect(rollbackDecision({ failures: 100, successes: 0, now: 1000, watch: null })).toBe('ok')
  })

  test('expired watch → expired', () => {
    expect(
      rollbackDecision({ failures: 100, successes: 0, now: BASE_WATCH.until + 1, watch: BASE_WATCH }),
    ).toBe('expired')
  })

  test('expired at the boundary (now === until) → expired', () => {
    expect(
      rollbackDecision({ failures: 10, successes: 0, now: BASE_WATCH.until, watch: BASE_WATCH }),
    ).toBe('expired')
  })

  test('below floor → ok (1 failure of 1 boot)', () => {
    expect(rollbackDecision({ failures: 1, successes: 0, now: 1500, watch: BASE_WATCH })).toBe('ok')
  })

  test(`at floor (${DEFAULT_MIN_FAILURES}) but rate is exactly 50% → ok (must exceed, not equal)`, () => {
    expect(
      rollbackDecision({ failures: DEFAULT_MIN_FAILURES, successes: DEFAULT_MIN_FAILURES, now: 1500, watch: BASE_WATCH }),
    ).toBe('ok')
  })

  test('at floor and majority rate → rollback', () => {
    // 5 failures, 4 successes → 55.6% > 50%
    expect(rollbackDecision({ failures: 5, successes: 4, now: 1500, watch: BASE_WATCH })).toBe('rollback')
  })

  test('high failure count but low rate → ok (5 failures among 20 boots is healthy churn)', () => {
    expect(rollbackDecision({ failures: 5, successes: 15, now: 1500, watch: BASE_WATCH })).toBe('ok')
  })

  test('custom thresholds are respected', () => {
    // 3 failures of 4 boots: would not rollback with defaults (floor=5), does with floor=3
    expect(
      rollbackDecision({ failures: 3, successes: 1, now: 1500, watch: BASE_WATCH, minFailures: 3, rate: 0.5 }),
    ).toBe('rollback')
    expect(
      rollbackDecision({ failures: 3, successes: 1, now: 1500, watch: BASE_WATCH, minFailures: 5, rate: 0.5 }),
    ).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// ColdBootLedger
// ---------------------------------------------------------------------------

describe('ColdBootLedger', () => {
  test('empty ledger returns zero counts', () => {
    const l = new ColdBootLedger()
    const c = l.counts()
    expect(c.failures).toBe(0)
    expect(c.successes).toBe(0)
    expect(c.topError).toBeNull()
  })

  test('records successes and failures', () => {
    const l = new ColdBootLedger()
    l.record(true)
    l.record(false, 'timeout')
    l.record(false, 'timeout')
    l.record(true)
    const c = l.counts()
    expect(c.failures).toBe(2)
    expect(c.successes).toBe(2)
    expect(c.topError).toBe('timeout')
  })

  test('since= filters by activation time', () => {
    const l = new ColdBootLedger()
    l.record(false, 'old', 100)
    l.record(false, 'recent', 200)
    l.record(true, undefined, 200)
    // only events at or after 150
    const c = l.counts(150)
    expect(c.failures).toBe(1)
    expect(c.successes).toBe(1)
    expect(c.topError).toBe('recent')
  })

  test('reset() clears all events', () => {
    const l = new ColdBootLedger()
    l.record(false, 'err')
    l.reset()
    const c = l.counts()
    expect(c.failures).toBe(0)
    expect(l.size()).toBe(0)
  })

  test('cap trims the oldest events', () => {
    const l = new ColdBootLedger(5)
    for (let i = 0; i < 10; i++) l.record(true)
    expect(l.size()).toBe(5)
  })

  test('topError returns the most common error message', () => {
    const l = new ColdBootLedger()
    l.record(false, 'socket timeout')
    l.record(false, 'socket timeout')
    l.record(false, 'health check failed')
    const c = l.counts()
    expect(c.topError).toBe('socket timeout')
  })
})

// ---------------------------------------------------------------------------
// bad-list helpers
// ---------------------------------------------------------------------------

describe('bad-list helpers', () => {
  const BAD: BadRootfs = { version: 'v1', revision: 'abc123', reason: 'boot probe failed', at: 1000 }

  test('addBadRootfs prepends and caps', () => {
    let list: BadRootfs[] = []
    list = addBadRootfs(list, BAD)
    expect(list).toHaveLength(1)
    expect(list[0].version).toBe('v1')

    // Fill past the cap
    for (let i = 0; i < BAD_CAP + 5; i++) {
      list = addBadRootfs(list, { version: `vx${i}`, revision: null, reason: 'x', at: 2000 })
    }
    expect(list).toHaveLength(BAD_CAP)
    // Newest first (last inserted)
    expect(list[0].version).toMatch(/^vx/)
  })

  test('findBadRootfs matches by version', () => {
    const list = [BAD]
    expect(findBadRootfs(list, 'v1', null)).toBe(BAD)
    expect(findBadRootfs(list, 'v2', null)).toBeNull()
  })

  test('findBadRootfs matches by revision when version differs', () => {
    const list = [BAD]
    expect(findBadRootfs(list, 'v99', 'abc123')).toBe(BAD)
  })

  test('findBadRootfs returns null when both differ', () => {
    const list = [BAD]
    expect(findBadRootfs(list, 'v99', 'xyz789')).toBeNull()
  })

  test('latestBadRootfs returns first entry or null', () => {
    expect(latestBadRootfs('')).toBeNull() // dir doesn't matter — file missing
    // With a real dir it reads from disk; tested via marker I/O below
  })
})

// ---------------------------------------------------------------------------
// marker I/O
// ---------------------------------------------------------------------------

describe('marker I/O', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpDir()
  })

  test('readWatch/writeWatch/clearWatch round-trip', () => {
    expect(readWatch(dir)).toBeNull()
    const w: RootfsWatch = { version: 'v1', prevVersion: 'v0', activatedAt: 1000, until: 2000 }
    writeWatch(dir, w)
    expect(readWatch(dir)).toEqual(w)
    clearWatch(dir)
    expect(readWatch(dir)).toBeNull()
  })

  test('readPrevious/writePrevious/clearPrevious round-trip', () => {
    expect(readPrevious(dir)).toBeNull()
    const p: RootfsPrevious = {
      version: 'v0',
      revision: 'abc',
      identities: { standard: 'sz1024-mt0' },
      activatedAt: 999,
    }
    writePrevious(dir, p)
    expect(readPrevious(dir)).toEqual(p)
    clearPrevious(dir)
    expect(readPrevious(dir)).toBeNull()
  })

  test('readBadList/writeBadList round-trip', () => {
    expect(readBadList(dir)).toEqual([])
    const list: BadRootfs[] = [{ version: 'v1', revision: null, reason: 'test', at: 1000 }]
    writeBadList(dir, list)
    expect(readBadList(dir)).toEqual(list)
  })

  test('latestBadRootfs returns newest entry after writeBadList', () => {
    const list: BadRootfs[] = [
      { version: 'v2', revision: null, reason: 'newer', at: 2000 },
      { version: 'v1', revision: null, reason: 'older', at: 1000 },
    ]
    writeBadList(dir, list)
    expect(latestBadRootfs(dir)?.version).toBe('v2')
  })

  test('missing or corrupt marker files return null / empty gracefully', () => {
    writeFileSync(join(dir, WATCH_MARKER), 'not-json')
    writeFileSync(join(dir, PREV_MARKER), 'not-json')
    writeFileSync(join(dir, BAD_MARKER), 'not-json')
    expect(readWatch(dir)).toBeNull()
    expect(readPrevious(dir)).toBeNull()
    expect(readBadList(dir)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// isPreviousImageOnDisk
// ---------------------------------------------------------------------------

describe('isPreviousImageOnDisk', () => {
  test('returns false when base is empty string', () => {
    expect(isPreviousImageOnDisk('')).toBe(false)
  })

  test('returns false when .prev does not exist', () => {
    const dir = tmpDir()
    expect(isPreviousImageOnDisk(join(dir, 'rootfs.ext4'))).toBe(false)
  })

  test('returns true when .prev exists', () => {
    const dir = tmpDir()
    const prev = join(dir, 'rootfs.ext4.prev')
    writeFileSync(prev, '')
    expect(isPreviousImageOnDisk(join(dir, 'rootfs.ext4'))).toBe(true)
  })
})
