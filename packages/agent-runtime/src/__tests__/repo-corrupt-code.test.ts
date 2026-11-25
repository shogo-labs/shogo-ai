// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-584 — the guest's failed-export body is a contract with the host.
 *
 * `code: 'repo-corrupt'` means "this `.git` cannot be walked; do not retry" and
 * makes the host block rotation for six hours. Anything else stays
 * `lfs-push-failed`, which the host retries. The two must never collapse into
 * one value — a transient push failure marked permanent would pin a VM to its
 * old rootfs, and a corrupt repo marked transient is the 525 MB-every-ten-
 * minutes loop this card removed.
 */

import { describe, expect, test } from 'bun:test'
import { LfsPushError } from '@shogo/shared-runtime'
import { lfsPushFailureBody } from '../server'

describe('lfsPushFailureBody (SHO-584)', () => {
  test('a corrupt repository gets its own code, distinct from a push failure', () => {
    const body = lfsPushFailureBody(
      new LfsPushError('git rev-list failed (128)', 'repo-corrupt', 'fatal: bad object 9f82099d', []),
    )
    expect(body.code).toBe('repo-corrupt')
    expect(body.reason).toBe('repo-corrupt')
    // The real stderr is what lets a human see the damage without shell access.
    expect(body.stderr).toBe('fatal: bad object 9f82099d')
  })

  test('a transient push failure keeps lfs-push-failed so the host retries it', () => {
    for (const reason of ['timeout', 'network', 'missing-objects', 'presign', 'auth', 'other'] as const) {
      const body = lfsPushFailureBody(new LfsPushError('push failed', reason))
      expect(body.code).toBe('lfs-push-failed')
      expect(body.reason).toBe(reason)
    }
  })

  test('missing objects ride along, so the lost paths are named', () => {
    const body = lfsPushFailureBody(
      new LfsPushError('some objects absent', 'missing-objects', '', [
        { oid: 'a'.repeat(64), paths: ['media/lost.mov'] },
      ]),
    )
    expect(body.code).toBe('lfs-push-failed')
    expect(body.missing).toEqual([{ oid: 'a'.repeat(64), paths: ['media/lost.mov'] }])
  })

  test('stderr is capped, so a giant dump cannot bloat the response', () => {
    const body = lfsPushFailureBody(new LfsPushError('boom', 'other', 'x'.repeat(20_000)))
    expect(body.stderr.length).toBe(16_000)
  })
})
