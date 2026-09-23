// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test'
import { deriveApiProfile, isLocalApiProfile } from '../profile'

describe('deriveApiProfile', () => {
  test('selects the local composer only for explicit local mode', () => {
    expect(deriveApiProfile({ SHOGO_LOCAL_MODE: 'true' })).toBe('local')
    expect(deriveApiProfile({ SHOGO_LOCAL_MODE: 'false' })).toBe('cloud')
    expect(deriveApiProfile({})).toBe('cloud')
  })

  test('does not mutate the supplied environment', () => {
    const env = { SHOGO_LOCAL_MODE: 'true' }
    expect(isLocalApiProfile(env)).toBe(true)
    expect(env).toEqual({ SHOGO_LOCAL_MODE: 'true' })
  })
})
