// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The agent is the one still writing files while the host's save is failing, so
 * it gets one line about it — and only while it is actually failing (SHO-442).
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetRepoDurabilityForTests,
  buildRepoDurabilitySection,
  noteRepoExportFailed,
  noteRepoExportSucceeded,
  repoDurabilityState,
} from '../repo-durability-prompt'

beforeEach(() => _resetRepoDurabilityForTests())

describe('buildRepoDurabilitySection', () => {
  test('a healthy workspace gets no block at all', () => {
    expect(buildRepoDurabilitySection()).toBeNull()
  })

  test('a failed save names the reason and how long ago it was', () => {
    const now = 1_000_000_000_000
    noteRepoExportFailed('missing-objects', 'Unable to find source for object abc', now - 3 * 60_000)

    const section = buildRepoDurabilitySection(now)!

    expect(section).toContain('## Your Changes Are Not Backed Up')
    expect(section).toContain('3 min ago')
    expect(section).toContain('missing-objects')
    expect(section).toContain('Unable to find source for object abc')
    // The one thing an agent must not do while the save is failing.
    expect(section).toContain('do not stop or restart the workspace')
  })

  test('a save that lands clears the block', () => {
    noteRepoExportFailed('timeout', 'lfs push timed out')
    expect(buildRepoDurabilitySection()).not.toBeNull()

    noteRepoExportSucceeded()

    expect(buildRepoDurabilitySection()).toBeNull()
    expect(repoDurabilityState().lastSuccessAt).toBeGreaterThan(0)
  })

  test('the detail is trimmed so one bad stderr cannot flood the prompt', () => {
    noteRepoExportFailed('other', 'x'.repeat(5_000))

    const section = buildRepoDurabilitySection()!

    expect(section.length).toBeLessThan(1_000)
  })
})
