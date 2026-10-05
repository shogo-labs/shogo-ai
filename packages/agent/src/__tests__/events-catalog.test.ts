// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  composioEventType,
  eventTypeMatches,
  memberJoined,
  parseComposioEventType,
  redactEventPayload,
  scopeForEventType,
  validateEventPayload,
} from '../events'

describe('event catalog', () => {
  test('member.joined example validates', () => {
    expect(validateEventPayload(memberJoined, memberJoined.example)).toEqual({ ok: true })
  })

  test('rejects missing and mistyped fields', () => {
    const result = validateEventPayload(memberJoined, { member: { role: 3 }, source: 'carrier_pigeon' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContain('member.userId is required')
      expect(result.errors).toContain('member.role must be a string')
      expect(result.errors.some((e) => e.startsWith('source must be one of'))).toBe(true)
    }
  })

  test('redacts email without members:read.email', () => {
    const redacted = redactEventPayload('member.joined', memberJoined.example, ['members:read'])
    expect(redacted.member.email).toBeUndefined()
    expect(redacted.member.name).toBe('Ada Lovelace')
    const full = redactEventPayload('member.joined', memberJoined.example, ['members:read', 'members:read.email'])
    expect(full.member.email).toBe('ada@example.com')
    expect(redactEventPayload('member.joined', memberJoined.example, '*')).toBe(memberJoined.example)
  })

  test('composio event types round-trip and map to toolkit scopes', () => {
    const type = composioEventType('GitHub', 'github_issue_added_event')
    expect(type).toBe('composio.github.GITHUB_ISSUE_ADDED_EVENT')
    expect(parseComposioEventType(type)).toEqual({ toolkit: 'github', triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT' })
    expect(parseComposioEventType('member.joined')).toBeNull()
    expect(scopeForEventType(type)).toBe('composio:github:read')
    expect(scopeForEventType('member.joined')).toBe('members:read')
  })

  test('wildcard matching', () => {
    expect(eventTypeMatches('composio.github.*', 'composio.github.GITHUB_ISSUE_ADDED_EVENT')).toBe(true)
    expect(eventTypeMatches('composio.github.*', 'composio.slack.SLACK_RECEIVE_MESSAGE')).toBe(false)
    expect(eventTypeMatches('member.joined', 'member.joined')).toBe(true)
  })
})
