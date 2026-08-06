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
 * The guard is structural (lineage: the ETag of the archive a workspace's
 * database descends from), with a size backstop for the one case lineage
 * cannot decide — an unknown-lineage writer. These tests exercise the pure
 * decision core, so no S3 is involved.
 */

import { describe, expect, test } from 'bun:test'
import {
  COLLAPSE_RATIO,
  DATA_MAX_BYTES,
  DATA_REAL_MIN_BYTES,
  dataArchiveKey,
  dataQuarantineKey,
  decideDataWrite,
  isDataCollapse,
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

  test('quarantine keys do not collide across rapid successive conflicts', () => {
    const keys = new Set(Array.from({ length: 50 }, () => dataQuarantineKey('proj-1')))
    expect(keys.size).toBe(50)
  })
})

describe('isDataCollapse', () => {
  test('an empty database replacing a populated one is a collapse', () => {
    expect(isDataCollapse(POPULATED, EMPTY)).toBe(true)
  })

  test('normal churn on a populated database is not a collapse', () => {
    expect(isDataCollapse(POPULATED, POPULATED + 1024)).toBe(false)
    expect(isDataCollapse(POPULATED, POPULATED * 0.9)).toBe(false)
  })

  test('the boundary is exactly COLLAPSE_RATIO of the current archive', () => {
    expect(isDataCollapse(POPULATED, POPULATED * COLLAPSE_RATIO)).toBe(true)
    expect(isDataCollapse(POPULATED, POPULATED * COLLAPSE_RATIO + 1)).toBe(false)
  })

  test('a small current archive is not worth protecting (nothing meaningful to lose)', () => {
    expect(isDataCollapse(DATA_REAL_MIN_BYTES - 1, 0)).toBe(false)
    expect(isDataCollapse(DATA_REAL_MIN_BYTES, 0)).toBe(true)
  })

  test('fails SAFE when either size is unknown — defers to the lineage decision', () => {
    expect(isDataCollapse(null, EMPTY)).toBe(false)
    expect(isDataCollapse(POPULATED, null)).toBe(false)
    expect(isDataCollapse(null, null)).toBe(false)
  })
})

describe('decideDataWrite', () => {
  test('no durable archive yet → create', () => {
    expect(
      decideDataWrite({ exists: false, currentEtag: null, incomingSize: EMPTY }),
    ).toBe('create')
  })

  test('lineage matches the current archive → overwrite', () => {
    expect(
      decideDataWrite({
        exists: true,
        currentEtag: '"abc"',
        parentEtag: '"abc"',
        currentSize: POPULATED,
        incomingSize: POPULATED,
      }),
    ).toBe('overwrite')
  })

  test('ETag quoting/weak-validator differences still count as matching lineage', () => {
    expect(
      decideDataWrite({ exists: true, currentEtag: 'W/"abc"', parentEtag: '"abc"' }),
    ).toBe('overwrite')
  })

  test('a matching-lineage SHRINK is allowed — the user deleted their own data', () => {
    // This must NOT be blocked: the workspace demonstrably descends from the
    // archive, so the shrink is intentional. Refusing it would strand the
    // archive and keep restoring data the user deliberately removed.
    expect(
      decideDataWrite({
        exists: true,
        currentEtag: '"abc"',
        parentEtag: '"abc"',
        currentSize: POPULATED,
        incomingSize: EMPTY,
      }),
    ).toBe('overwrite')
  })

  test('THE INCIDENT: unknown lineage + empty database over a populated archive → quarantine', () => {
    // A VM that cold-booted after its snapshot was invalidated has no data
    // lineage and a freshly-created database. Adopting it would erase the
    // user's data permanently; quarantine keeps the bytes and the archive.
    expect(
      decideDataWrite({
        exists: true,
        currentEtag: '"real"',
        parentEtag: undefined,
        currentSize: POPULATED,
        incomingSize: EMPTY,
      }),
    ).toBe('quarantine')
  })

  test('unknown lineage carrying real data adopts (so rollout can converge)', () => {
    // The complement of the case above, and why unknown lineage is not refused
    // outright: the first VM to export after this shipped has no lineage. If
    // that always quarantined, a small archive written first could never be
    // replaced by the real one.
    expect(
      decideDataWrite({
        exists: true,
        currentEtag: '"small"',
        parentEtag: undefined,
        currentSize: EMPTY,
        incomingSize: POPULATED,
      }),
    ).toBe('adopt')
  })

  test('unknown lineage with unknown sizes adopts (fails safe toward persisting)', () => {
    expect(
      decideDataWrite({ exists: true, currentEtag: '"real"', parentEtag: undefined }),
    ).toBe('adopt')
  })

  test('a MISMATCHED lineage always quarantines, whatever the sizes', () => {
    // Unlike unknown lineage, a stale ETag is positive evidence the writer does
    // not descend from what is in S3 — never adopt, even carrying more bytes.
    expect(
      decideDataWrite({
        exists: true,
        currentEtag: '"current"',
        parentEtag: '"stale"',
        currentSize: EMPTY,
        incomingSize: POPULATED,
      }),
    ).toBe('quarantine')
  })
})

describe('DATA_MAX_BYTES', () => {
  test('matches the guest hydrate request-body cap — an archive we cannot restore is useless', () => {
    expect(DATA_MAX_BYTES).toBe(1024 * 1024 * 1024)
  })
})
