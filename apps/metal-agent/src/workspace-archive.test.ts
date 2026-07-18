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
import {
  decideBackupWrite,
  etagEq,
  isTemplateRegression,
  quarantineKey,
  REAL_MIN_BYTES,
  TEMPLATE_MAX_BYTES,
} from './workspace-archive'

const TEMPLATE_BYTES = 337_752 // an observed real template export size
const REAL_BYTES = 6_537_360 // an observed real user backup size

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
    // A legacy resume carrying REAL content over a real backup still adopts:
    // the size backstop only fires on a regression to a template-shaped export.
    expect(
      decideBackupWrite({
        exists: true,
        currentEtag: '"current"',
        parentEtag: undefined,
        adoptWhenUnknown: true,
        currentSize: REAL_BYTES,
        incomingSize: REAL_BYTES + 1000,
      }),
    ).toBe('adopt')
  })

  test('THE SECOND VECTOR: a template snapshot laundered to origin=snapshot must NOT adopt a template over a real backup', () => {
    // dal-1 clobber path: a template VM snapshotted locally, resumed as
    // origin 'snapshot' with NO parent etag, then adopted a ~337 KB template
    // over a real multi-MB backup. The size backstop turns that adopt into a
    // quarantine so the real backup survives.
    expect(
      decideBackupWrite({
        exists: true,
        currentEtag: '"real-6mb"',
        parentEtag: undefined,
        adoptWhenUnknown: true,
        currentSize: REAL_BYTES,
        incomingSize: TEMPLATE_BYTES,
      }),
    ).toBe('quarantine')
  })

  test('size backstop defers to lineage when sizes are unknown (fails safe, no false quarantine)', () => {
    // Old callers / a HEAD that could not read a size must not change behavior:
    // adopt still adopts when we cannot prove a regression.
    expect(
      decideBackupWrite({
        exists: true,
        currentEtag: '"current"',
        parentEtag: undefined,
        adoptWhenUnknown: true,
        currentSize: null,
        incomingSize: TEMPLATE_BYTES,
      }),
    ).toBe('adopt')
  })

  test('size backstop does NOT block a matching-lineage overwrite (legit user shrink persists)', () => {
    // An overwrite means the VM PROVABLY descends from the current backup, so a
    // shrink is the same workspace evolving (e.g. the user deleted assets). The
    // backstop only guards the unverifiable `adopt` path, never a real overwrite.
    expect(
      decideBackupWrite({
        exists: true,
        currentEtag: '"v2"',
        parentEtag: '"v2"',
        currentSize: REAL_BYTES,
        incomingSize: TEMPLATE_BYTES,
      }),
    ).toBe('overwrite')
  })
})

describe('isTemplateRegression (size backstop core)', () => {
  test('real → template-shaped is a regression', () => {
    expect(isTemplateRegression(REAL_BYTES, TEMPLATE_BYTES)).toBe(true)
  })
  test('real → real is not', () => {
    expect(isTemplateRegression(REAL_BYTES, REAL_BYTES)).toBe(false)
  })
  test('small (sub-real) current → template is not (avoids false-positive on tiny real projects)', () => {
    // Current below the real floor: we can't be sure it was real, so defer.
    expect(isTemplateRegression(TEMPLATE_MAX_BYTES + 1, TEMPLATE_BYTES)).toBe(false)
  })
  test('unknown sizes never regress', () => {
    expect(isTemplateRegression(null, TEMPLATE_BYTES)).toBe(false)
    expect(isTemplateRegression(REAL_BYTES, null)).toBe(false)
  })
  test('boundary: incoming exactly at the template ceiling, current exactly at the real floor', () => {
    expect(isTemplateRegression(REAL_MIN_BYTES, TEMPLATE_MAX_BYTES)).toBe(true)
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
