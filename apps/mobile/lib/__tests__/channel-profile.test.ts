// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import {
  PERSONAL_MANAGED_CHANNEL_TYPES,
  isManagedChannelForProfile,
  visibleChannelTypesForProfile,
} from '../channel-profile'

const ALL = ['telegram', 'discord', 'slack', 'slack-agent', 'whatsapp', 'email', 'webhook'] as const

describe('channel-profile — personal BYO boundary', () => {
  test('team keeps every channel type', () => {
    expect(visibleChannelTypesForProfile(ALL, 'team')).toEqual([...ALL])
    for (const type of ALL) {
      expect(isManagedChannelForProfile(type, 'team')).toBe(false)
    }
  })

  test('personal hides the byo Telegram/WhatsApp/Slack rows', () => {
    const visible = visibleChannelTypesForProfile(ALL, 'personal')
    for (const managed of PERSONAL_MANAGED_CHANNEL_TYPES) {
      expect(visible).not.toContain(managed)
    }
    // unrelated channels stay configurable
    expect(visible).toContain('discord')
    expect(visible).toContain('webhook')
    expect(visible).toContain('email')
  })

  test('isManagedChannelForProfile only flags personal + the managed set', () => {
    expect(isManagedChannelForProfile('telegram', 'personal')).toBe(true)
    expect(isManagedChannelForProfile('whatsapp', 'personal')).toBe(true)
    expect(isManagedChannelForProfile('slack', 'personal')).toBe(true)
    // `slack-agent` is a distinct type and is not part of the managed set
    expect(isManagedChannelForProfile('slack-agent', 'personal')).toBe(false)
    expect(isManagedChannelForProfile('discord', 'personal')).toBe(false)
    expect(isManagedChannelForProfile('telegram', 'team')).toBe(false)
  })
})
