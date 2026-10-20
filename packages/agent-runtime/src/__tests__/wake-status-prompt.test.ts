// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "what this session is holding" block: it only appears while a wake pause
 * is in place, names the updates waiting, and says they are already queued.
 */

import { describe, expect, test } from 'bun:test'
import { buildWakeStatusSection } from '../wake-status-prompt'

const waiting = [
  { taskId: 't_a1', source: 'work_item', title: 'SHO-88 Sim kernel', finishedAt: '2026-10-20T09:00:00.000Z' },
  { taskId: 't_b2', source: 'agent_reply', title: '@Ops reply', finishedAt: null },
]

describe('buildWakeStatusSection', () => {
  test('a running session gets no block at all', () => {
    expect(buildWakeStatusSection(null)).toBeNull()
    expect(buildWakeStatusSection(undefined)).toBeNull()
    expect(buildWakeStatusSection({ paused: false, wakesInARow: 1, limit: 3, waiting: [] })).toBeNull()
  })

  test('a paused session is told what is waiting, and that it is already queued', () => {
    const section = buildWakeStatusSection({ paused: true, wakesInARow: 3, limit: 3, waiting })!
    expect(section).toContain('## Background Updates Waiting')
    expect(section).toContain('2 background task updates are waiting')
    expect(section).toContain('paused after 3 wake turns in a row (limit 3)')
    expect(section).toContain('- SHO-88 Sim kernel')
    expect(section).toContain('- @Ops reply')
    expect(section).toContain('Do not re-ask for these')
  })

  test('a pause with no titles still says it is paused rather than inventing one', () => {
    const section = buildWakeStatusSection({ paused: true, wakesInARow: 3, limit: 3, waiting: [] })!
    expect(section).toContain('Some background task updates are waiting')
    expect(section).not.toContain('- ')
  })
})
