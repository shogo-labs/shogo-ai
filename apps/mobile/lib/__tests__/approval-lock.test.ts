// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }))
mock.module('expo-local-authentication', () => ({}))

describe('shouldPromptBiometric', () => {
  test('asks only when enabled and the phone can', async () => {
    const { shouldPromptBiometric } = await import('../approval-lock')
    expect(shouldPromptBiometric({ platform: 'ios', enabled: true, hasHardware: true, enrolled: true })).toBe(true)
  })

  test('never asks when the setting is off', async () => {
    const { shouldPromptBiometric } = await import('../approval-lock')
    expect(shouldPromptBiometric({ platform: 'ios', enabled: false, hasHardware: true, enrolled: true })).toBe(false)
  })

  test('does not lock out a phone with no biometrics set up', async () => {
    const { shouldPromptBiometric } = await import('../approval-lock')
    expect(shouldPromptBiometric({ platform: 'android', enabled: true, hasHardware: true, enrolled: false })).toBe(false)
    expect(shouldPromptBiometric({ platform: 'android', enabled: true, hasHardware: false, enrolled: false })).toBe(false)
  })

  test('web never asks', async () => {
    const { shouldPromptBiometric } = await import('../approval-lock')
    expect(shouldPromptBiometric({ platform: 'web', enabled: true, hasHardware: true, enrolled: true })).toBe(false)
  })
})
