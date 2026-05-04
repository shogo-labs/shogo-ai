// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { parsePtyClientFrame, serializePtyFrame } from '../pty-protocol'

describe('pty protocol', () => {
  test('parses init frames with clamped dimensions', () => {
    expect(parsePtyClientFrame(JSON.stringify({ type: 'init', cols: 9999, rows: 0 }))).toEqual({
      type: 'init',
      sessionId: undefined,
      cols: 500,
      rows: 2,
      cwd: undefined,
      shell: undefined,
    })
  })

  test('rejects malformed and unknown frames', () => {
    expect(() => parsePtyClientFrame('{')).toThrow()
    expect(() => parsePtyClientFrame(JSON.stringify({ type: 'wat' }))).toThrow('Unknown PTY frame type')
  })

  test('serializes server frames as JSON', () => {
    expect(serializePtyFrame({ type: 'pong' })).toBe('{"type":"pong"}')
  })
})
