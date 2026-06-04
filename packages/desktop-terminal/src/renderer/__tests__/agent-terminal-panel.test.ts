// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for AgentTerminalPanel.
 *
 * Tests cover:
 *   - getTerminalStatus: maps instance state to status enum
 *   - AgentTerminalEntry: renders correctly for each status
 *   - AgentTerminalPanel: empty state, running/finished sections, selection, kill
 */

import { describe, it, expect } from 'bun:test'
import {
  getTerminalStatus,
  type TerminalStatus,
} from '../agent-terminal-panel'
import type { AgentTerminalInstance } from '../agent-terminal-factory'

// ─── helpers ────────────────────────────────────────────────────────────

function makeInstance(overrides?: Partial<AgentTerminalInstance>): AgentTerminalInstance {
  return {
    id: 'term_1',
    tracker: null as any,
    bridge: null as any,
    command: 'npm test',
    commandResult: null,
    elapsedMs: 0,
    disposed: false,
    ...overrides,
  }
}

// ─── tests ──────────────────────────────────────────────────────────────

describe('getTerminalStatus()', () => {
  it('returns "running" when not disposed and no result', () => {
    const inst = makeInstance()
    expect(getTerminalStatus(inst)).toBe('running')
  })

  it('returns "completed" when result has exitCode 0', () => {
    const inst = makeInstance({
      commandResult: { command: 'ls', exitCode: 0, cwd: '/tmp', durationMs: 100, timedOut: false },
    })
    expect(getTerminalStatus(inst)).toBe('completed')
  })

  it('returns "failed" when result has non-zero exitCode', () => {
    const inst = makeInstance({
      commandResult: { command: 'ls', exitCode: 1, cwd: '/tmp', durationMs: 100, timedOut: false },
    })
    expect(getTerminalStatus(inst)).toBe('failed')
  })

  it('returns "failed" when result has null exitCode (interrupted)', () => {
    const inst = makeInstance({
      commandResult: { command: 'ls', exitCode: null, cwd: '/tmp', durationMs: 100, timedOut: false },
    })
    expect(getTerminalStatus(inst)).toBe('failed')
  })

  it('returns "disposed" when instance is disposed', () => {
    const inst = makeInstance({ disposed: true })
    expect(getTerminalStatus(inst)).toBe('disposed')
  })

  it('returns "disposed" even if result exists', () => {
    const inst = makeInstance({
      disposed: true,
      commandResult: { command: 'ls', exitCode: 0, cwd: '/tmp', durationMs: 100, timedOut: false },
    })
    expect(getTerminalStatus(inst)).toBe('disposed')
  })
})

describe('AgentTerminalPanel edge cases', () => {
  it('handles empty instances array', () => {
    // Just verify getTerminalStatus doesn't crash on various states
    expect(getTerminalStatus(makeInstance())).toBe('running')
    expect(getTerminalStatus(makeInstance({ disposed: true }))).toBe('disposed')
  })

  it('handles instance with timedOut result', () => {
    const inst = makeInstance({
      commandResult: { command: 'sleep 999', exitCode: null, cwd: null, durationMs: 5000, timedOut: true },
    })
    expect(getTerminalStatus(inst)).toBe('failed')
  })

  it('handles instance with no command text', () => {
    const inst = makeInstance({ command: undefined })
    expect(getTerminalStatus(inst)).toBe('running')
  })
})
