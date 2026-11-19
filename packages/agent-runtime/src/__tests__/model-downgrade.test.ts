// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model-downgrade notice (SHO-417, AC5).
 *
 * The API moves a run off a model the acting person cannot use and stamps
 * `modelDowngrade` on the chat body; the runtime must state that in the reply's
 * first line. These tests pin the two halves that can silently break: reading
 * the payload off the body, and the sentence the person actually reads.
 *
 *   bun --no-env-file test src/__tests__/model-downgrade.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { modelDowngradeNotice, parseModelDowngrade } from '../model-downgrade'

describe('parseModelDowngrade', () => {
  test('reads a well-formed payload', () => {
    expect(parseModelDowngrade({ from: 'claude-opus-4-5', to: 'claude-haiku-4-5' })).toEqual({
      from: 'claude-opus-4-5',
      to: 'claude-haiku-4-5',
    })
  })

  test('keeps display labels when the API sent them', () => {
    expect(
      parseModelDowngrade({
        from: 'claude-opus-4-5',
        to: 'claude-haiku-4-5',
        fromLabel: 'Claude Opus 4.5',
        toLabel: 'Claude Haiku 4.5',
      }),
    ).toEqual({
      from: 'claude-opus-4-5',
      to: 'claude-haiku-4-5',
      fromLabel: 'Claude Opus 4.5',
      toLabel: 'Claude Haiku 4.5',
    })
  })

  test('ignores a payload with no models', () => {
    expect(parseModelDowngrade(null)).toBeNull()
    expect(parseModelDowngrade(undefined)).toBeNull()
    expect(parseModelDowngrade('claude-opus-4-5')).toBeNull()
    expect(parseModelDowngrade({})).toBeNull()
    expect(parseModelDowngrade({ from: 'claude-opus-4-5' })).toBeNull()
    expect(parseModelDowngrade({ to: 'claude-haiku-4-5' })).toBeNull()
  })

  test('ignores empty and non-string model ids', () => {
    expect(parseModelDowngrade({ from: '', to: 'claude-haiku-4-5' })).toBeNull()
    expect(parseModelDowngrade({ from: 42, to: 'claude-haiku-4-5' })).toBeNull()
    expect(parseModelDowngrade({ from: 'claude-opus-4-5', to: null })).toBeNull()
  })

  test('drops a blank label rather than printing an empty name', () => {
    expect(parseModelDowngrade({ from: 'a', to: 'b', fromLabel: '', toLabel: 7 })).toEqual({
      from: 'a',
      to: 'b',
    })
  })
})

describe('modelDowngradeNotice', () => {
  test('names the fallback and the model the person cannot use', () => {
    const notice = modelDowngradeNotice({ from: 'claude-opus-4-5', to: 'claude-haiku-4-5' })
    expect(notice).toBe("Ran on claude-haiku-4-5 because your role can't use claude-opus-4-5.\n\n")
  })

  test('prefers display names when it has them', () => {
    const notice = modelDowngradeNotice({
      from: 'claude-opus-4-5',
      to: 'claude-haiku-4-5',
      fromLabel: 'Claude Opus 4.5',
      toLabel: 'Claude Haiku 4.5',
    })
    expect(notice).toBe("Ran on Claude Haiku 4.5 because your role can't use Claude Opus 4.5.\n\n")
  })

  test('falls back to the id for a model with no label', () => {
    const notice = modelDowngradeNotice({
      from: 'claude-opus-4-5',
      to: 'claude-haiku-4-5',
      toLabel: 'Claude Haiku 4.5',
    })
    expect(notice).toBe("Ran on Claude Haiku 4.5 because your role can't use claude-opus-4-5.\n\n")
  })

  test('is one line followed by a blank line, so it reads as a preamble', () => {
    const notice = modelDowngradeNotice({ from: 'a', to: 'b' })
    const [first, second] = notice.split('\n')
    expect(first).toBe("Ran on b because your role can't use a.")
    expect(second).toBe('')
    expect(notice.endsWith('\n\n')).toBe(true)
  })
})
