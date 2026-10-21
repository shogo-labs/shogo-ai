// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 — the threshold must come from the *resolved model's* catalog window,
 * not from a hardcoded 200k window.
 *
 * Russell saw a turn on opus-5-5 reach 400k with nothing summarized. opus-5-5
 * had no `contextWindow` in the catalog, so the runtime assumed a 200k window
 * (≈168k after reserve) while the provider accepted far more, and nothing else
 * bounded the growth.
 */
import { describe, test, expect } from 'bun:test'
// Source import on purpose: the catalog package's dist is not rebuilt for
// unit runs, and this test must fail on the source that ships.
import { getContextWindowTokens } from '../../../agent/src/model-catalog/index'
import { DEFAULT_AUTOCOMPACT_TOKENS, resolveAutoCompactTokens } from '../session-manager'

describe('model catalog context windows', () => {
  test('claude-opus-5-5 declares its real window', () => {
    expect(getContextWindowTokens('claude-opus-5-5')).toBe(1_000_000)
  })

  test('claude-haiku-5-5 declares its real window', () => {
    expect(getContextWindowTokens('claude-haiku-5-5')).toBe(1_000_000)
  })

  test('an unknown model returns undefined rather than inventing a window', () => {
    expect(getContextWindowTokens('definitely-not-a-model')).toBeUndefined()
  })

  test('every 1M-window model summarizes at the 200k cap', () => {
    for (const id of ['claude-opus-5-5', 'claude-haiku-5-5']) {
      expect(resolveAutoCompactTokens({ contextWindowTokens: getContextWindowTokens(id) })).toBe(
        DEFAULT_AUTOCOMPACT_TOKENS,
      )
    }
  })
})
