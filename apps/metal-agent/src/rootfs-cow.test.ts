// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Sizing and monitoring of the per-VM dm-snapshot CoW store.
 *
 * The failure this guards against is not a slow VM. When a persistent
 * exception store runs out of room the kernel prints "Invalidating snapshot:
 * Unable to allocate exception" and every write to that device fails from then
 * on, while the guest stays up and keeps answering health checks. Production
 * ran a fixed 2 GiB store against a 13.4 GiB image and lost VMs to it.
 *
 * So the properties worth pinning are: a store is always big enough that the
 * guest's own filesystem fills first, an undersized setting cannot reintroduce
 * the cliff, stores that predate the fix get the headroom when they are next
 * attached, and the states dm reports on the way over the edge are recognised.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cowTargetBytes, ensureCowSize, parseCowStatus, safeCowBytes } from './rootfs'

const GiB = 1024 ** 3
/** The real staging/production golden image: 28174336 sectors. */
const ORIGIN = 28174336 * 512

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cow-test-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('safeCowBytes', () => {
  test('covers the whole origin, so the guest filesystem fills before the store', () => {
    // The guest can dirty every block of its 13.4 GiB rootfs. If the store
    // cannot hold that many exceptions there is a reachable amount of writing
    // that kills the VM, which is the bug.
    expect(safeCowBytes(ORIGIN)).toBeGreaterThan(ORIGIN)
  })

  test('adds room for the exception metadata interleaved with the data', () => {
    // A persistent store spends one chunk describing each run of exceptions,
    // so covering the origin costs slightly more than the origin itself.
    const overhead = safeCowBytes(ORIGIN) - ORIGIN
    expect(overhead).toBeGreaterThanOrEqual(ORIGIN / 256)
  })

  test('stays close to the origin rather than over-reserving', () => {
    // Sparse files make a generous figure cheap, but not free: it is also the
    // worst case the host's disk has to absorb, so it should be the size of
    // the thing plus its bookkeeping, not a multiple of it.
    expect(safeCowBytes(ORIGIN)).toBeLessThan(ORIGIN * 1.02)
  })

  test('is chunk-aligned', () => {
    expect(safeCowBytes(ORIGIN) % 4096).toBe(0)
    expect(safeCowBytes(1) % 4096).toBe(0)
  })

  test('the real image needs more than the 2 GiB that was configured', () => {
    // The regression test for the incident: the old default was not merely
    // tight, it was a small fraction of what the image can dirty.
    expect(safeCowBytes(ORIGIN)).toBeGreaterThan(2 * GiB)
  })
})

describe('cowTargetBytes', () => {
  test('derives a safe size when unset', () => {
    expect(cowTargetBytes(ORIGIN, 'auto')).toEqual({
      bytes: safeCowBytes(ORIGIN),
      raisedFloor: false,
    })
  })

  test('raises an explicit setting that is too small, and says so', () => {
    // Undersizing is never a valid choice: it does not bound what a VM
    // consumes, it just decides when the VM dies.
    const got = cowTargetBytes(ORIGIN, '2G')
    expect(got.bytes).toBe(safeCowBytes(ORIGIN))
    expect(got.raisedFloor).toBe(true)
  })

  test('honours an explicit setting that is larger', () => {
    const got = cowTargetBytes(ORIGIN, '64G')
    expect(got.bytes).toBe(64 * GiB)
    expect(got.raisedFloor).toBe(false)
  })

  test('an unparseable setting falls back to the derived size without complaining', () => {
    // 'auto' takes this path, and so does a typo. Neither is a floor being
    // overridden, so neither should produce a warning about one.
    expect(cowTargetBytes(ORIGIN, 'not-a-size').raisedFloor).toBe(false)
  })
})

describe('ensureCowSize', () => {
  test('creates a store at the target size', () => {
    const dir = tmp()
    try {
      const p = join(dir, 'a.cow')
      expect(ensureCowSize(p, 8 * 1024 * 1024)).toBe('created')
      expect(statSync(p).size).toBe(8 * 1024 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('grows a store left behind by the old fixed size', () => {
    // Every VM provisioned before this fix carries an undersized store and
    // outlives a deploy, so the fix only reaches them if attaching grows them.
    const dir = tmp()
    try {
      const p = join(dir, 'b.cow')
      ensureCowSize(p, 2 * 1024 * 1024)
      expect(ensureCowSize(p, 16 * 1024 * 1024)).toBe('grown')
      expect(statSync(p).size).toBe(16 * 1024 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never shrinks, which would strand allocated exceptions off the end', () => {
    const dir = tmp()
    try {
      const p = join(dir, 'c.cow')
      ensureCowSize(p, 16 * 1024 * 1024)
      expect(ensureCowSize(p, 4 * 1024 * 1024)).toBe('unchanged')
      expect(statSync(p).size).toBe(16 * 1024 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('growing preserves the bytes already written', () => {
    // The store is not a scratch file: it holds the VM's entire divergence
    // from the golden image. Resizing it must not disturb a single byte.
    const dir = tmp()
    try {
      const p = join(dir, 'd.cow')
      const payload = Buffer.alloc(4096, 0xab)
      writeFileSync(p, payload)
      expect(ensureCowSize(p, 1024 * 1024)).toBe('grown')
      expect(statSync(p).size).toBe(1024 * 1024)
      expect(readFileSync(p).subarray(0, 4096).equals(payload)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is a no-op when the store is already the right size', () => {
    const dir = tmp()
    try {
      const p = join(dir, 'e.cow')
      ensureCowSize(p, 1024 * 1024)
      expect(ensureCowSize(p, 1024 * 1024)).toBe('unchanged')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseCowStatus', () => {
  // Real `dmsetup status` output: the agent's own devices alongside whatever
  // else is mapped on the host, which must be ignored.
  const HEALTHY = [
    'mvm-fcvm-1000-mrys8z88: 0 28174336 snapshot 1180984/4194304 4608',
    'mvm-fcvm-1001-mrys9219: 0 28174336 snapshot 584000/4194304 2048',
    'vg0-root: 0 209715200 linear',
  ].join('\n')

  test('reports the fullest store', () => {
    const u = parseCowStatus(HEALTHY)
    expect(u.measured).toBe(2)
    expect(u.invalid).toBe(0)
    expect(u.maxUsedPct).toBeCloseTo(28.16, 1)
  })

  test('ignores devices that are not ours', () => {
    expect(parseCowStatus(HEALTHY).measured).toBe(2)
  })

  test('counts stores in the danger band', () => {
    const out = [
      'mvm-a: 0 28174336 snapshot 3800000/4194304 4608', // 90.6%
      'mvm-b: 0 28174336 snapshot 100/4194304 4608',
    ].join('\n')
    expect(parseCowStatus(out).nearLimit).toBe(1)
  })

  test('recognises a snapshot the kernel has already invalidated', () => {
    // The state that matters most, and the one that reads nothing like the
    // healthy shape: dm drops the fraction entirely.
    const u = parseCowStatus('mvm-dead: 0 28174336 snapshot Invalid')
    expect(u.invalid).toBe(1)
    expect(u.maxUsedPct).toBe(100)
  })

  test('recognises Overflow and Merge failed as broken too', () => {
    const u = parseCowStatus(
      ['mvm-x: 0 28174336 snapshot Overflow', 'mvm-y: 0 28174336 snapshot Merge failed'].join('\n'),
    )
    expect(u.invalid).toBe(2)
  })

  test('a healthy fleet reports zero invalid', () => {
    // The gauge is meant to be flat zero, so anything that makes a normal host
    // look broken would be a page in the middle of the night for nothing.
    expect(parseCowStatus(HEALTHY).invalid).toBe(0)
  })

  test('survives empty and malformed output', () => {
    for (const s of ['', '\n\n', 'garbage', 'mvm-x: 0 28174336 snapshot', 'mvm-y: 0 1 snapshot 5/0 1']) {
      expect(() => parseCowStatus(s)).not.toThrow()
    }
    expect(parseCowStatus('').measured).toBe(0)
  })
})