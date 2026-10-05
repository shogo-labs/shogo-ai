// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { grantableScopes, parseAppManifest, scopesForEventPattern } from '../events'

describe('parseAppManifest', () => {
  test('accepts a hook + Composio app and fills defaults', () => {
    const result = parseAppManifest(JSON.stringify({
      scopes: ['members:read'],
      optionalScopes: ['members:read.email', 'members:read'],
      requiredToolkits: ['GitHub'],
      events: [
        { type: 'member.joined' },
        { type: 'composio.github.GITHUB_ISSUE_ADDED_EVENT', target: 'agent', prompt: ' Triage ', config: { repo: 'x' } },
      ],
    }))
    expect(result).toEqual({
      ok: true,
      manifest: {
        schemaVersion: 1,
        scopes: ['members:read'],
        optionalScopes: ['members:read.email'],
        requiredToolkits: ['github'],
        events: [
          { type: 'member.joined', target: 'hook' },
          { type: 'composio.github.GITHUB_ISSUE_ADDED_EVENT', target: 'agent', prompt: 'Triage', config: { repo: 'x' } },
        ],
      },
    })
  })

  test('reports every problem at once', () => {
    const result = parseAppManifest({
      schemaVersion: 2,
      scopes: ['files:delete'],
      events: [
        { type: 'member.joined', target: 'agent' },
        { type: 'composio.github.*' },
        { type: 'composio.slack.SLACK_RECEIVE_MESSAGE' },
        { type: 'nope.happened' },
        { type: 'member.joined', target: 'shell' },
        { type: 'member.joined', config: {} },
      ],
    })
    expect(result.ok).toBe(false)
    const errors = result.ok ? [] : result.errors
    expect(errors).toEqual(expect.arrayContaining([
      'schemaVersion must be 1',
      expect.stringContaining('Unknown scope "files:delete"'),
      'events[0]: member.joined requires the "members:read" scope; add it to scopes',
      'events[0].prompt is required for agent targets',
      expect.stringContaining('events[1]: Composio events need an exact type'),
      'events[2]: composio.slack.SLACK_RECEIVE_MESSAGE needs "slack" in requiredToolkits',
      'events[3]: unknown event type nope.happened',
      'events[4].target must be "hook" or "agent"',
      'events[5].config only applies to Composio events',
    ]))
  })

  test('rejects malformed JSON and duplicate subscriptions', () => {
    expect(parseAppManifest('{').ok).toBe(false)
    const dup = parseAppManifest({ scopes: ['members:read'], events: [{ type: 'member.joined' }, { type: 'member.joined' }] })
    expect(dup.ok ? [] : dup.errors).toEqual([expect.stringContaining('listed twice')])
  })

  test('wildcards need the scope of every matching event', () => {
    expect(scopesForEventPattern('member.*')).toEqual(['members:read'])
    expect(scopesForEventPattern('composio.github.GITHUB_STAR_ADDED_EVENT')).toEqual(['composio:github:read'])
  })

  test('grantableScopes adds accepted optional scopes and toolkit read scopes only', () => {
    const parsed = parseAppManifest({ scopes: ['members:read'], optionalScopes: ['members:read.email'], requiredToolkits: ['github'] })
    if (!parsed.ok) throw new Error(parsed.errors.join())
    expect(grantableScopes(parsed.manifest).sort()).toEqual(['composio:github:read', 'members:read'])
    expect(grantableScopes(parsed.manifest, ['members:read.email', 'chat:write']).sort()).toEqual(['composio:github:read', 'members:read', 'members:read.email'])
  })
})
