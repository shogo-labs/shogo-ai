// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  DESKTOP_TERMINAL_CLOSE_REASONS,
  DESKTOP_COLS_MIN,
  DESKTOP_COLS_MAX,
  DESKTOP_ROWS_MIN,
  DESKTOP_ROWS_MAX,
} from '../desktop-protocol'

describe('desktop-protocol — close reasons', () => {
  it('exposes the canonical terminal-close reasons', () => {
    expect(DESKTOP_TERMINAL_CLOSE_REASONS).toEqual([
      'pty:exited',
      'pty:killed',
      'pty:max-age',
      'pty:idle',
      'pty:shutdown',
      'no-session',
    ])
  })
  it('is a read-only array (frozen at the type layer; runtime array is the SoT)', () => {
    expect(Array.isArray(DESKTOP_TERMINAL_CLOSE_REASONS)).toBe(true)
    expect(DESKTOP_TERMINAL_CLOSE_REASONS.length).toBeGreaterThan(0)
  })
})

describe('desktop-protocol — dimension bounds', () => {
  it('cols min is 1 (zero or negative columns make no sense for xterm)', () => {
    expect(DESKTOP_COLS_MIN).toBe(1)
  })
  it('rows min is 1', () => {
    expect(DESKTOP_ROWS_MIN).toBe(1)
  })
  it('cols max is 1000 (defense-in-depth ceiling)', () => {
    expect(DESKTOP_COLS_MAX).toBe(1000)
  })
  it('rows max is 1000', () => {
    expect(DESKTOP_ROWS_MAX).toBe(1000)
  })
  it('min < max for both axes', () => {
    expect(DESKTOP_COLS_MIN).toBeLessThan(DESKTOP_COLS_MAX)
    expect(DESKTOP_ROWS_MIN).toBeLessThan(DESKTOP_ROWS_MAX)
  })
})
