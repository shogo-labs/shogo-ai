// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  CAPABILITY_INFO,
  CAPABILITY_KEYS,
  mergeCapabilitySettingsIntoConfig,
  mergeCapabilitySettingsIntoWorkspaceSettings,
  normalizeCapabilitySettings,
  parseWorkspaceSettings,
  resolveCapabilities,
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

describe('CAPABILITY_INFO', () => {
  test('every capability key has a label and a summary', () => {
    expect(Object.keys(CAPABILITY_INFO).sort()).toEqual([...CAPABILITY_KEYS].sort())
    for (const key of CAPABILITY_KEYS) {
      expect(CAPABILITY_INFO[key].label.length).toBeGreaterThan(0)
      expect(CAPABILITY_INFO[key].summary.length).toBeGreaterThan(0)
    }
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


describe('resolveCapabilities', () => {
  test('project scope leaves the workspace-agent opt-ins off unless stored', () => {
    const caps = resolveCapabilities({}, { scope: 'project' })
    expect(caps.boardAdminEnabled).toBe(false)
    expect(caps.companyOpsEnabled).toBe(false)
    expect(caps.problemsEnabled).toBe(false)
  })

  test('workspace scope turns the workspace-agent opt-ins on for unset keys', () => {
    const caps = resolveCapabilities({}, { scope: 'workspace' })
    expect(caps.boardAdminEnabled).toBe(true)
    expect(caps.companyOpsEnabled).toBe(true)
    expect(caps.problemsEnabled).toBe(true)
    // Everything else keeps its normal default.
    expect(caps.webEnabled).toBe(true)
    expect(caps.socialMediaEnabled).toBe(false)
  })

  test('an explicit workspace setting wins over the workspace defaults', () => {
    const caps = resolveCapabilities({ boardAdminEnabled: false, problemsEnabled: false }, { scope: 'workspace' })
    expect(caps.boardAdminEnabled).toBe(false)
    expect(caps.problemsEnabled).toBe(false)
    expect(caps.companyOpsEnabled).toBe(true)
  })

  test('an unset scope resolves as project (the pre-split behaviour)', () => {
    const caps = resolveCapabilities({})
    expect(caps.boardAdminEnabled).toBe(false)
  })

  test('the runtime\'s active mode is authoritative for canvas', () => {
    // A stale `canvasEnabled: false` (e.g. an anchor project's toggle synced
    // into a runtime that is composing a canvas) must not render canvas off.
    const caps = resolveCapabilities({ canvasEnabled: false, activeMode: 'canvas' })
    expect(caps.canvasEnabled).toBe(true)
    const off = resolveCapabilities({ canvasEnabled: true, activeMode: 'none' })
    expect(off.canvasEnabled).toBe(false)
    // No mode recorded: the stored toggle stands.
    expect(resolveCapabilities({ canvasEnabled: false }).canvasEnabled).toBe(false)
  })
})

describe('workspace settings helpers', () => {
  test('parseWorkspaceSettings accepts a JSON string, an object, or nothing', () => {
    expect(parseWorkspaceSettings('{"boardAdminEnabled":true}')).toEqual({ boardAdminEnabled: true })
    expect(parseWorkspaceSettings({ boardAdminEnabled: false })).toEqual({ boardAdminEnabled: false })
    expect(parseWorkspaceSettings(null)).toEqual({})
    expect(parseWorkspaceSettings('not-json')).toEqual({})
  })

  test('merging a capability patch preserves the workspace\'s other settings', () => {
    const { settings, changed } = mergeCapabilitySettingsIntoWorkspaceSettings(
      { theme: 'dark', boardAdminEnabled: true },
      { boardAdminEnabled: false, canvasEnabled: false, activeMode: 'none' },
    )
    expect(changed).toBe(true)
    expect(settings.theme).toBe('dark')
    expect(settings.boardAdminEnabled).toBe(false)
    expect(settings.canvasEnabled).toBe(false)
    expect(settings.activeMode).toBe('none')
    // Keys the patch does not mention are not invented.
    expect(settings.shellEnabled).toBeUndefined()
  })

  test('a patch that changes nothing reports changed: false', () => {
    const first = mergeCapabilitySettingsIntoWorkspaceSettings({}, { shellEnabled: true })
    const second = mergeCapabilitySettingsIntoWorkspaceSettings(first.settings, { shellEnabled: true })
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
  })

  test('unknown keys in a patch are ignored, not stored', () => {
    const { settings } = mergeCapabilitySettingsIntoWorkspaceSettings({}, { notACapability: true } as never)
    expect(settings.notACapability).toBeUndefined()
  })
})
