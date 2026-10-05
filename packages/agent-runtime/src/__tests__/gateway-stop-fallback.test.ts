// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A user Stop must not be reported as "Sorry, I was unable to generate a
 * response". The agent loop marks a Stop with `abortReason: 'external'`; other
 * empty turns (no abort, or an abort for another reason) keep the fallback.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUserStoppedTurn } from '../gateway'

describe('isUserStoppedTurn', () => {
  test('is true only for an external (user) abort', () => {
    expect(isUserStoppedTurn({ abortReason: 'external' })).toBe(true)
  })

  test('is false for other aborts and for turns that were not aborted', () => {
    expect(isUserStoppedTurn({ abortReason: 'max_iterations' })).toBe(false)
    expect(isUserStoppedTurn({ abortReason: 'loop_detected' })).toBe(false)
    expect(isUserStoppedTurn({})).toBe(false)
  })
})

describe('empty-turn fallback wiring', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'gateway.ts'), 'utf8')

  test('the stop check runs before the fallback is built or streamed', () => {
    const stopCheck = source.indexOf('if (isUserStoppedTurn(result)) return')
    const fallback = source.indexOf("const emptyFallback = 'Sorry, I was unable to generate a response")
    expect(stopCheck).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(-1)
    expect(stopCheck).toBeLessThan(fallback)
  })

  test('the zero-token "issue processing your message" error is skipped for a stop', () => {
    expect(source).toMatch(
      /result\.outputTokens === 0 && result\.toolCalls\.length === 0 && !isHeartbeat && !isUserStoppedTurn\(result\)/,
    )
  })
})
