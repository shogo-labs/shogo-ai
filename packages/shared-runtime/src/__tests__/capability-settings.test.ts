// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  CAPABILITY_KEYS,
  mergeCapabilitySettingsIntoConfig,
  normalizeCapabilitySettings,
} from '../capability-settings'

describe('normalizeCapabilitySettings', () => {
  test('defaults: most toggles on, opt-in toggles off, platforms on', () => {
    for (const input of [undefined, null, 'not-json', [], 1]) {
      const caps = normalizeCapabilitySettings(input)
      expect(caps.webEnabled).toBe(true)
      expect(caps.shellEnabled).toBe(true)
      expect(caps.heartbeatToolsEnabled).toBe(true)
      expect(caps.gitWorktreesEnabled).toBe(false)
      expect(caps.socialMediaEnabled).toBe(false)
      expect(caps.socialInstagramEnabled).toBe(true)
      expect(caps.socialTiktokEnabled).toBe(true)
    }
  })

  test('an explicit false sticks, and opt-in stays off unless exactly true', () => {
    const caps = normalizeCapabilitySettings({
      webEnabled: false,
      socialMediaEnabled: 'yes',
      gitWorktreesEnabled: 1,
      socialInstagramEnabled: false,
    })
    expect(caps.webEnabled).toBe(false)
    expect(caps.browserEnabled).toBe(true)
    expect(caps.socialMediaEnabled).toBe(false)
    expect(caps.gitWorktreesEnabled).toBe(false)
    expect(caps.socialInstagramEnabled).toBe(false)
    expect(caps.socialTiktokEnabled).toBe(true)
  })

  test('unwraps a JSON-encoded settings string before applying defaults', () => {
    const caps = normalizeCapabilitySettings(JSON.stringify({
      socialMediaEnabled: true,
      webEnabled: false,
    }))
    expect(caps.socialMediaEnabled).toBe(true)
    expect(caps.webEnabled).toBe(false)
    expect(caps.gitWorktreesEnabled).toBe(false)
  })

  test('opt-in toggles turn on only for boolean true', () => {
    const caps = normalizeCapabilitySettings({
      socialMediaEnabled: true,
      gitWorktreesEnabled: true,
    })
    expect(caps.socialMediaEnabled).toBe(true)
    expect(caps.gitWorktreesEnabled).toBe(true)
  })

  test('heartbeatEnabled is the legacy alias, and heartbeatToolsEnabled wins', () => {
    expect(normalizeCapabilitySettings({ heartbeatEnabled: false }).heartbeatToolsEnabled).toBe(false)
    expect(
      normalizeCapabilitySettings({ heartbeatEnabled: false, heartbeatToolsEnabled: true }).heartbeatToolsEnabled,
    ).toBe(true)
  })
})

describe('mergeCapabilitySettingsIntoConfig', () => {
  test('database values replace a stale cache and leave other keys alone', () => {
    const { config, changed } = mergeCapabilitySettingsIntoConfig(
      { socialMediaEnabled: false, webEnabled: false, model: { name: 'kept' } },
      { socialMediaEnabled: true, webEnabled: true },
    )
    expect(changed).toBe(true)
    expect(config.socialMediaEnabled).toBe(true)
    expect(config.webEnabled).toBe(true)
    expect(config.model).toEqual({ name: 'kept' })
    expect(config.gitWorktreesEnabled).toBe(false)
  })

  test('reports unchanged when the cache already matches the defaults', () => {
    const first = mergeCapabilitySettingsIntoConfig({}, {})
    const second = mergeCapabilitySettingsIntoConfig(first.config, {})
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(Object.keys(second.config).sort()).toEqual([...CAPABILITY_KEYS].sort())
  })
})
