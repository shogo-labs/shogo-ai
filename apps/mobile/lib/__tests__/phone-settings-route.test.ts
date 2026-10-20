// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  isPhoneSettingsSurface,
  phoneSettingsSheetTab,
  phoneSettingsTarget,
  resolvePhoneSettingsTab,
  resolveRequestedWorkspaceId,
} from '../phone-settings-route'

const CLOUD_ANDROID = {
  localMode: false,
  showBilling: true,
  platform: 'android',
}
const CLOUD_IOS = { localMode: false, showBilling: true, platform: 'ios' }
const LOCAL = { localMode: true, showBilling: false, platform: 'android' }

describe('isPhoneSettingsSurface', () => {
  test('native handset and narrow web are the phone surface', () => {
    expect(isPhoneSettingsSurface(390, 844)).toBe(true)
    expect(isPhoneSettingsSurface(767, 800)).toBe(true)
  })

  test('wide web and tablets keep the Settings page', () => {
    expect(isPhoneSettingsSurface(768, 800)).toBe(false)
    expect(isPhoneSettingsSurface(1440, 900)).toBe(false)
  })
})

describe('phoneSettingsTarget', () => {
  test('no tab lands on the Account home with no sheet', () => {
    expect(phoneSettingsTarget({}, CLOUD_ANDROID)).toEqual({
      pathname: '/(app)/account',
      params: {},
    })
  })

  test('forwards every other query param untouched', () => {
    expect(
      phoneSettingsTarget(
        { tab: 'automations', workspace: 'w1', slackLinked: '1', whatsNew: '1.2.3' },
        CLOUD_ANDROID,
      ),
    ).toEqual({
      pathname: '/(app)/account',
      params: {
        tab: 'automations',
        workspace: 'w1',
        slackLinked: '1',
        whatsNew: '1.2.3',
      },
    })
  })

  test('usage and cost deep links keep going to Analytics', () => {
    expect(phoneSettingsTarget({ tab: 'analytics' }, CLOUD_ANDROID)).toEqual({
      pathname: '/(app)/analytics',
      params: { view: 'usage' },
    })
    expect(phoneSettingsTarget({ tab: 'costs' }, CLOUD_ANDROID)).toEqual({
      pathname: '/(app)/analytics',
      params: { view: 'costs' },
    })
  })

  test('unavailable tabs degrade to the Workspace tab, never a blank sheet', () => {
    for (const tab of ['updates', 'computer-files', 'bogus-tab']) {
      expect(phoneSettingsTarget({ tab }, CLOUD_ANDROID).params.tab).toBe(
        'workspace',
      )
    }
    // People are cloud-only, Security is local-only.
    expect(phoneSettingsTarget({ tab: 'people' }, LOCAL).params.tab).toBe(
      'workspace',
    )
    expect(phoneSettingsTarget({ tab: 'security' }, LOCAL).params.tab).toBe(
      'security',
    )
    expect(phoneSettingsTarget({ tab: 'people' }, CLOUD_ANDROID).params.tab).toBe(
      'people',
    )
  })

  test('Compute survives on Android and degrades on iOS and local mode', () => {
    expect(phoneSettingsTarget({ tab: 'compute' }, CLOUD_ANDROID).params.tab).toBe(
      'compute',
    )
    expect(phoneSettingsTarget({ tab: 'compute' }, CLOUD_IOS).params.tab).toBe(
      'workspace',
    )
    expect(phoneSettingsTarget({ tab: 'compute' }, LOCAL).params.tab).toBe(
      'workspace',
    )
  })
})

describe('phoneSettingsSheetTab', () => {
  test('no tab means the Account home, no sheet', () => {
    expect(phoneSettingsSheetTab({}, CLOUD_ANDROID)).toBeNull()
  })

  test('an analytics link never opens a settings sheet', () => {
    expect(phoneSettingsSheetTab({ tab: 'analytics' }, CLOUD_ANDROID)).toBeNull()
    expect(phoneSettingsSheetTab({ tab: 'costs' }, CLOUD_ANDROID)).toBeNull()
  })

  test('resolves the same tab the redirect carries', () => {
    for (const tab of ['workspace', 'people', 'integrations', 'automations', 'remote-control', 'models', 'billing', 'account', 'appearance']) {
      expect(phoneSettingsSheetTab({ tab }, CLOUD_ANDROID)).toBe(tab as never)
    }
  })
})

describe('resolvePhoneSettingsTab', () => {
  test('falls back to Workspace for an unknown id', () => {
    expect(resolvePhoneSettingsTab('nope', CLOUD_ANDROID)).toBe('workspace')
  })
})

describe('resolveRequestedWorkspaceId', () => {
  test('ignores a missing id or an unloaded list', () => {
    expect(resolveRequestedWorkspaceId(undefined, ['w1'])).toBeNull()
    expect(resolveRequestedWorkspaceId('w2', [])).toBeNull()
  })

  test('resolves an id the user owns', () => {
    expect(resolveRequestedWorkspaceId('w2', ['w1', 'w2'])).toBe('w2')
  })
})
