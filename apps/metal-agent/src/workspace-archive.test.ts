// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * workspace-archive — the STRUCTURAL anti-clobber invariant.
 *
 * The incident: an unconditional last-writer-wins PUT let a workspace that came
 * up as the bare template overwrite a project's real (multi-MB/GB) source
 * backup with a ~337 KB template on the next idle-suspend. The fix makes the
 * write conditional on LINEAGE — a writer may only overwrite the durable object
 * it actually descends from. These tests pin the decision core (S3-free) that
 * `uploadWorkspaceArchiveGuarded` runs, plus ETag normalization.
 */

import { describe, expect, test } from 'bun:test'
import { decideBackupWrite, etagEq, quarantineKey } from './workspace-archive'

describe('decideBackupWrite (anti-clobber invariant)', () => {
  test('no object in S3 → create the first backup', () => {
    expect(decideBackupWrite({ exists: false, currentEtag: null })).toBe('create')
    // Even a template origin (no parent) legitimately creates the FIRST backup
    // for a genuinely new project.
    expect(decideBackupWrite({ exists: false, currentEtag: null, parentEtag: undefined })).toBe('create')
  })

  test('writer descends from the current object → overwrite', () => {
    expect(decideBackupWrite({ exists: true, currentEtag: '"v2"', parentEtag: '"v2"' })).toBe('overwrite')
  })

  test('THE INCIDENT: template origin (no lineage) over an existing backup → quarantine, never clobber', () => {
    expect(decideBackupWrite({ exists: true, currentEtag: '"real-38mb"', parentEtag: undefined })).toBe('quarantine')
    // ...and adopt does NOT rescue a template — only a legacy snapshot origin
    // sets adoptWhenUnknown, and a template must never set it.
    expect(
      decideBackupWrite({ exists: true, currentEtag: '"real-38mb"', parentEtag: undefined, adoptWhenUnknown: false }),
    ).toBe('quarantine')
  })

  test('stale lineage (known mismatch) → quarantine even if adopt is allowed', () => {
    // A resume of a stale snapshot has a KNOWN-but-wrong parent etag. adopt only
    // trusts UNKNOWN lineage, so a mismatch must still quarantine.
    expect(
      decideBackupWrite({ exists: true, currentEtag: '"current"', parentEtag: '"stale"', adoptWhenUnknown: true }),
    ).toBe('quarantine')
  })

  test('migration: legacy snapshot with unknown lineage + adopt → adopt (self-heals)', () => {
    expect(
      decideBackupWrite({ exists: true, currentEtag: '"current"', parentEtag: undefined, adoptWhenUnknown: true }),
    ).toBe('adopt')
  })

  test('cross-host race: a losing writer whose lineage no longer matches → quarantine', () => {
    // Both hosts descended from "v1"; one wins and advances S3 to "v2". The
    // other still carries "v1" and must NOT clobber the winner's write.
    expect(decideBackupWrite({ exists: true, currentEtag: '"v2"', parentEtag: '"v1"' })).toBe('quarantine')
  })
})

describe('quarantineKey (top-level prefix for lifecycle TTL)', () => {
  // The OCI lifecycle rule `cleanup-quarantined-exports` (terraform/modules/
  // object-storage) TTLs quarantined exports by the `conflict/` prefix. That
  // rule ONLY works if quarantine keys are top-level `conflict/...` and NEVER
  // `{projectId}/conflict/...` (a per-project prefix can't be prefix-matched),
  // and must never collide with a live `{projectId}/project-src.tar.gz`.
  test('lives under the top-level conflict/ prefix, namespaced per project', () => {
    const k = quarantineKey('proj-123')
    expect(k.startsWith('conflict/proj-123/')).toBe(true)
    expect(k.endsWith('.tar.gz')).toBe(true)
    // Must NOT be under the project prefix (would dodge the lifecycle rule and
    // could shadow the real source listing).
    expect(k.startsWith('proj-123/')).toBe(false)
  })

  test('two conflicts for the same project never collide', () => {
    expect(quarantineKey('p1')).not.toBe(quarantineKey('p1'))
  })
})

describe('etagEq (quote/weak-validator normalization)', () => {
  test('equal ignoring quotes and the weak prefix', () => {
    expect(etagEq('"abc"', 'abc')).toBe(true)
    expect(etagEq('W/"abc"', '"abc"')).toBe(true)
    expect(etagEq('abc', 'abc')).toBe(true)
  })

  test('unequal values, and null/undefined never match', () => {
    expect(etagEq('"abc"', '"def"')).toBe(false)
    expect(etagEq(null, null)).toBe(false)
    expect(etagEq(undefined, '"abc"')).toBe(false)
    expect(etagEq('"abc"', null)).toBe(false)
  })
})
