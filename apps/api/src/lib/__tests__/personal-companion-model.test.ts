// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/personal-companion-model.ts — the
 * admin-selectable model powering the personal companion's interactive chat.
 *
 *   bun test apps/api/src/lib/__tests__/personal-companion-model.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'

// No module mocking needed here — this file doesn't touch any network/DB
// seam, unlike title-model.test.ts (which mocks `resolve-language-model` /
// `ai` to drive `generateText`). Sharing that mock across test files in the
// same bun:test process caused cross-file interference (a later, more
// complete mock of the same path got shadowed), so import the real constant
// directly instead.
import { DEFAULT_ASSISTANT_MODEL } from '../resolve-language-model'
import {
  DEFAULT_PERSONAL_COMPANION_MODEL_ID,
  setPersonalCompanionModelId,
  getPersonalCompanionModelId,
  getPersonalCompanionModelOverride,
} from '../personal-companion-model'

beforeEach(() => {
  setPersonalCompanionModelId(null)
})

describe('personal-companion model id resolution', () => {
  test('defaults to the shared assistant model id (Hoshi 2.0) when unset', () => {
    expect(DEFAULT_PERSONAL_COMPANION_MODEL_ID).toBe(DEFAULT_ASSISTANT_MODEL)
    expect(getPersonalCompanionModelId()).toBe('hoshi-2-0')
    expect(getPersonalCompanionModelOverride()).toBeNull()
  })

  test('returns the configured id once a super admin sets one', () => {
    setPersonalCompanionModelId('claude-sonnet-4-6')
    expect(getPersonalCompanionModelId()).toBe('claude-sonnet-4-6')
    expect(getPersonalCompanionModelOverride()).toBe('claude-sonnet-4-6')
  })

  test('resets to the default on empty/whitespace-only input', () => {
    setPersonalCompanionModelId('claude-sonnet-4-6')
    setPersonalCompanionModelId('   ')
    expect(getPersonalCompanionModelId()).toBe(DEFAULT_PERSONAL_COMPANION_MODEL_ID)
    expect(getPersonalCompanionModelOverride()).toBeNull()
  })

  test('resets to the default on null/undefined', () => {
    setPersonalCompanionModelId('claude-sonnet-4-6')
    setPersonalCompanionModelId(null)
    expect(getPersonalCompanionModelId()).toBe(DEFAULT_PERSONAL_COMPANION_MODEL_ID)
    setPersonalCompanionModelId('claude-sonnet-4-6')
    setPersonalCompanionModelId(undefined)
    expect(getPersonalCompanionModelId()).toBe(DEFAULT_PERSONAL_COMPANION_MODEL_ID)
  })

  test('trims whitespace around a configured id', () => {
    setPersonalCompanionModelId('  claude-sonnet-4-6  ')
    expect(getPersonalCompanionModelId()).toBe('claude-sonnet-4-6')
  })
})
