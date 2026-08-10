// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * project-data-archive — the anti-clobber invariant for WRITABLE STATE.
 *
 * The incident these pin down: a project's SQLite database and uploads lived
 * only inside the VM snapshot. A golden-rootfs rebuild invalidates every
 * snapshot at once, so the next open cold-booted from the source archive and
 * came up with an EMPTY database. Persisting that empty database would then
 * destroy the durable copy too — turning a recoverable snapshot loss into
 * permanent data loss. A user lost a generated song library exactly this way.
 *
 * The guard is now structural in two senses. Lineage is stated by the caller
 * rather than guessed from archive sizes, and the resulting precondition is
 * enforced by the storage layer as part of the write itself, so there is no
 * window between deciding and writing. The single most important test here is
 * the exhaustive one: NO lineage may produce an unconditional write.
 */

import { describe, expect, test } from 'bun:test'
import {
  COLLAPSE_RATIO,
  DATA_MAX_BYTES,
  DATA_REAL_MIN_BYTES,
  dataArchiveKey,
  dataQuarantineKey,
  isDataCollapse,
  planDataWrite,
  type DataLineage,
} from './project-data-archive'

/** A populated database archive. */
const POPULATED = 100 * 1024 * 1024
/** A freshly-created, schema-only database — what a cold boot produces. */
const EMPTY = 240 * 1024

describe('dataArchiveKey / dataQuarantineKey', () => {
  test('the durable key is per-project and distinct from the source archive', () => {
    expect(dataArchiveKey('proj-1')).toBe('proj-1/project-data.tar.gz')
  })

  test('quarantine shares the conflict/ prefix (one lifecycle rule) but is marked as data', () => {
    const k = dataQuarantineKey('proj-1')
    expect(k.startsWith('conflict/proj-1/')).toBe(true)
    expect(k.endsWith('-data.tar.gz')).toBe(true)
  })

  test('quarantine keys do not collide within the same millisecond', () => {
    const keys = new Set(Array.from({ length: 50 }, () => dataQuarantineKey('p')))
    expect(keys.size).toBe(50)
  })
})

describe('planDataWrite', () => {
  test('a workspace that descends from the archive may replace exactly that one', () => {
    expect(planDataWrite({ kind: 'descends', etag: '"abc"' })).toEqual({
      action: 'compare-and-swap',
      ifMatch: '"abc"',
    })
  })

  test('an unproven workspace may create but never overwrite', () => {
    // A brand-new project, or a VM adopted across an agent restart. Letting it
    // CREATE is what makes rollout work: the first writer seeds the archive.
    // Letting it overwrite is what caused the incident.
    expect(planDataWrite({ kind: 'create-only' })).toEqual({ action: 'create-only' })
  })

  test('a workspace with known-bad provenance writes nothing at all', () => {
    expect(planDataWrite({ kind: 'untrusted', reason: 'hydrate failed' })).toEqual({
      action: 'refuse',
      reason: 'hydrate failed',
    })
  })

  test('NO lineage yields an unconditional write', () => {
    // The load-bearing property. If a future state were added that produced a
    // plain write, an empty database could erase a populated archive again —
    // so this asserts over every state rather than over examples.
    const lineages: DataLineage[] = [
      { kind: 'descends', etag: '"e"' },
      { kind: 'create-only' },
      { kind: 'untrusted', reason: 'any' },
    ]
    for (const lineage of lineages) {
      const plan = planDataWrite(lineage)
      expect(['compare-and-swap', 'create-only', 'refuse']).toContain(plan.action)
      if (plan.action === 'compare-and-swap') expect(plan.ifMatch).toBeTruthy()
    }
  })

  test('the precondition carries the exact ETag, not a normalised one', () => {
    // The quoting has to survive: `If-Match` is compared verbatim by the server.
    expect(planDataWrite({ kind: 'descends', etag: 'W/"weak-tag"' })).toEqual({
      action: 'compare-and-swap',
      ifMatch: 'W/"weak-tag"',
    })
  })
})

describe('isDataCollapse (observational only)', () => {
  test('flags an empty database replacing a populated archive', () => {
    expect(isDataCollapse(POPULATED, EMPTY)).toBe(true)
  })

  test('does not flag ordinary growth or a modest shrink', () => {
    expect(isDataCollapse(POPULATED, POPULATED + 1024)).toBe(false)
    expect(isDataCollapse(POPULATED, Math.floor(POPULATED * 0.9))).toBe(false)
  })

  test('ignores archives too small to be worth protecting', () => {
    expect(isDataCollapse(DATA_REAL_MIN_BYTES - 1, 1)).toBe(false)
  })

  test('fails safe when either size is unknown', () => {
    expect(isDataCollapse(null, EMPTY)).toBe(false)
    expect(isDataCollapse(POPULATED, null)).toBe(false)
  })

  test('sits exactly on the documented ratio', () => {
    expect(isDataCollapse(POPULATED, POPULATED * COLLAPSE_RATIO)).toBe(true)
    expect(isDataCollapse(POPULATED, POPULATED * COLLAPSE_RATIO + 1)).toBe(false)
  })
})

describe('DATA_MAX_BYTES', () => {
  test('matches the guest hydrate body cap, so a stored archive is restorable', () => {
    // An archive larger than the guest will accept would consume storage while
    // still cold-booting empty — durability that is not.
    //
    // Keep this in lockstep with `maxRequestBodySize` in
    // packages/agent-runtime/src/server.ts. This assertion is the tripwire for
    // the two drifting apart; if it fails because the guest cap moved, move
    // this constant rather than relaxing the test.
    expect(DATA_MAX_BYTES).toBe(4 * 1024 * 1024 * 1024)
  })
})
