// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-584 — a failing repo export must say WHY it failed, because the host
 * decides from that whether to retry later (LFS objects still uploading) or to
 * stop exporting entirely (a `.git` that cannot be walked). Getting this wrong
 * in either direction is how one VM spent six days re-exporting 525 MB every
 * ten minutes: a permanent failure treated as transient.
 */

import { describe, expect, test } from 'bun:test'
import { LfsPushError, classifyLfsFailure } from '../lfs'

describe('classifyLfsFailure', () => {
  test('a .git that cannot be walked is repo-corrupt, and wins over the phrases below it', () => {
    // Real output: rev-list fails on the pack, but the line also says "object"
    // and "No such file", which would otherwise read as missing-objects.
    const stderr = [
      'Error downloading object: media/big.mp4',
      "fatal: bad object 9f82099d4c0b3f7a1e5d6c8b9a0f1e2d3c4b5a69",
      'error: object file .git/objects/9f/82099d4c0b3f7a1e5d6c8b9a0f1e2d3c4b5a69 is empty',
      'No such file or directory',
    ].join('\n')
    expect(classifyLfsFailure(stderr)).toBe('repo-corrupt')
  })

  test('a corrupt packfile or a broken link is repo-corrupt', () => {
    expect(classifyLfsFailure('fatal: packfile .git/objects/pack/pack-1a2b.pack is corrupt')).toBe('repo-corrupt')
    expect(classifyLfsFailure('error: broken link from commit 1a2b to tree 3c4d')).toBe('repo-corrupt')
  })

  test('objects absent on both sides are missing-objects, not corruption', () => {
    const stderr = 'Unable to find source for object 3c4d (mapped to media/lost.mov)\nbatch response: object does not exist'
    expect(classifyLfsFailure(stderr)).toBe('missing-objects')
  })

  test('timeouts, presign expiry, auth and network each keep their own class', () => {
    expect(classifyLfsFailure('batch request timed out after 60s')).toBe('timeout')
    expect(classifyLfsFailure('Request has expired: X-Amz-Signature mismatch')).toBe('presign')
    expect(classifyLfsFailure('fatal: Authentication failed for lfs.shogo.ai', 403)).toBe('auth')
    expect(classifyLfsFailure('send-pack: unexpected disconnect while reading sideband packet; ECONNRESET')).toBe('network')
  })

  test('a 503 body with no text is network, so the host retries it', () => {
    // A bare 5xx must not read as permanent: the next attempt may well work.
    expect(classifyLfsFailure('', 503)).toBe('network')
  })

  test('empty output and no status is other — never silently permanent or transient', () => {
    expect(classifyLfsFailure('')).toBe('other')
  })

  test('LfsPushError carries the reason and the raw stderr through', () => {
    const err = new LfsPushError('lfs push failed', 'repo-corrupt', 'fatal: bad object abc', [])
    expect(err.reason).toBe('repo-corrupt')
    expect(err.stderr).toBe('fatal: bad object abc')
  })
})
