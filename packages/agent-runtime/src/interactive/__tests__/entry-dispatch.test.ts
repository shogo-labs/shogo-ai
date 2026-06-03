// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { isInteractiveMode } from '../entry'

const SERVER_ARGV = ['bun', '/app/agent-runtime']

describe('isInteractiveMode (entry dispatch predicate)', () => {
  test('SHOGO_INTERACTIVE=1 selects interactive', () => {
    expect(isInteractiveMode(SERVER_ARGV, { SHOGO_INTERACTIVE: '1' })).toBe(true)
  })

  test('SHOGO_INTERACTIVE=true selects interactive', () => {
    expect(isInteractiveMode(SERVER_ARGV, { SHOGO_INTERACTIVE: 'true' })).toBe(true)
  })

  test('an "interactive" argv positional selects interactive', () => {
    expect(isInteractiveMode(['bun', '/app/agent-runtime', 'interactive'], {})).toBe(true)
  })

  test('a "chat" argv positional selects interactive', () => {
    expect(isInteractiveMode(['bun', '/app/agent-runtime', 'chat'], {})).toBe(true)
  })

  test('default server invocation does NOT select interactive', () => {
    expect(isInteractiveMode(SERVER_ARGV, {})).toBe(false)
  })

  test('SHOGO_INTERACTIVE=0 does NOT select interactive', () => {
    expect(isInteractiveMode(SERVER_ARGV, { SHOGO_INTERACTIVE: '0' })).toBe(false)
  })
})
