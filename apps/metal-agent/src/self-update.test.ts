// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the self-update decision guard. We deliberately test the pure
 * `shouldUpdate` (not the IO-driving maybeSelfUpdate) so the "when do we apply"
 * policy is pinned without downloading/swapping/restarting: never when disabled,
 * never on a missing/malformed release, never when already on the version, and
 * yes only on a real, well-formed version change.
 */

import { describe, expect, test } from 'bun:test'
import { shouldUpdate, type DesiredAgent } from './self-update'

const rel = (over: Partial<DesiredAgent> = {}): DesiredAgent => ({
  version: 'v2',
  bundleUrl: 's3://bucket/agent-v2.tgz',
  sha256: 'abc',
  ...over,
})

describe('shouldUpdate', () => {
  test('applies on a real version change when enabled', () => {
    expect(shouldUpdate('v1', rel(), true)).toBe(true)
  })

  test('never applies when self-update is disabled', () => {
    expect(shouldUpdate('v1', rel(), false)).toBe(false)
  })

  test('does not apply when already on the desired version', () => {
    expect(shouldUpdate('v2', rel({ version: 'v2' }), true)).toBe(false)
  })

  test('does not apply on null/undefined desired', () => {
    expect(shouldUpdate('v1', null, true)).toBe(false)
    expect(shouldUpdate('v1', undefined, true)).toBe(false)
  })

  test('does not apply on a malformed release (missing version or bundleUrl)', () => {
    expect(shouldUpdate('v1', rel({ version: '' }), true)).toBe(false)
    expect(shouldUpdate('v1', rel({ bundleUrl: '' }), true)).toBe(false)
  })

  test("'unknown' dev version never equals a published version → updates once", () => {
    expect(shouldUpdate('unknown', rel(), true)).toBe(true)
  })
})
