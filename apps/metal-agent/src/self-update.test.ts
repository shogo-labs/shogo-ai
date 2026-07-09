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
import { shouldRebuildRootfs, shouldUpdate, type DesiredAgent } from './self-update'

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

/**
 * `shouldRebuildRootfs` decouples the golden-rootfs rebuild from the agent
 * code-version gate. Regression for the 2026-07 "guest rootfs stale after agent
 * self-update" incident: a commit that changed both the agent and the runtime
 * chain published two SAME-version releases — the immediate push (rebuild=false)
 * and, minutes later, the runtime-image workflow_run (rebuild=true). The host had
 * already updated its code on the first, so the version matched and the
 * rebuild-flagged release was silently dropped. The rebuild is now keyed off a
 * local "last-built" marker instead of the code version.
 */
describe('shouldRebuildRootfs', () => {
  const rebuildRel = (over: Partial<DesiredAgent> = {}): DesiredAgent =>
    rel({ rebuildRootfs: true, ...over })

  test('rebuilds when the release asks for it and we never built this version', () => {
    // The core race: version already matches (code updated), marker is an OLDER
    // version → we must still rebuild.
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v1', true)).toBe(true)
    // Fresh host, no marker yet.
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), null, true)).toBe(true)
  })

  test('does not rebuild again once we have built this exact version', () => {
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v2', true)).toBe(false)
  })

  test('does not rebuild when the release does not ask for it', () => {
    expect(shouldRebuildRootfs(rel({ version: 'v2', rebuildRootfs: false }), 'v1', true)).toBe(false)
    expect(shouldRebuildRootfs(rel({ version: 'v2' }), 'v1', true)).toBe(false)
  })

  test('never rebuilds when self-update is disabled', () => {
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v1', false)).toBe(false)
  })

  test('does not rebuild on null/undefined or version-less desired', () => {
    expect(shouldRebuildRootfs(null, 'v1', true)).toBe(false)
    expect(shouldRebuildRootfs(undefined, 'v1', true)).toBe(false)
    expect(shouldRebuildRootfs(rebuildRel({ version: '' }), 'v1', true)).toBe(false)
  })
})
