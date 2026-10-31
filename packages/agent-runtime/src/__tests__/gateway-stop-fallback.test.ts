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
    // The empty-turn line is class-derived since SHO-270; the boilerplate
    // apology is only the `unknown` branch.
    const fallback = source.indexOf('const emptyFallback =')
    expect(stopCheck).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(-1)
    expect(stopCheck).toBeLessThan(fallback)
  })

  test('a known failure class ends the turn with its own line, not the apology', () => {
    const fallback = source.slice(source.indexOf('const emptyFallback ='))
    const failureLine = fallback.indexOf('buildTurnFailureMessage(failureClass')
    const apology = fallback.indexOf('Sorry, I was unable to generate a response')
    expect(failureLine).toBeGreaterThan(-1)
    expect(apology).toBeGreaterThan(failureLine)
  })

  test('the zero-token "issue processing your message" error is skipped for a stop and a usage limit', () => {
    expect(source).toMatch(
      /result\.outputTokens === 0 && result\.toolCalls\.length === 0 && !result\.usageLimit && !isHeartbeat && !isUserStoppedTurn\(result\)/,
    )
  })
})
