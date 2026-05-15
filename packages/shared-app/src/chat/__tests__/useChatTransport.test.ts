// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import { buildChatApiUrl, buildChatTurnUrl } from '../useChatTransport'

describe('buildChatApiUrl', () => {
  it('returns local agent URL when provided', () => {
    expect(buildChatApiUrl('http://localhost:8002', 'proj_1', 'http://localhost:3000'))
      .toBe('http://localhost:3000/agent/chat')
  })

  it('builds project-scoped URL when projectId is provided', () => {
    expect(buildChatApiUrl('http://localhost:8002', 'proj_123'))
      .toBe('http://localhost:8002/api/projects/proj_123/chat')
  })

  it('builds generic chat URL when no projectId or localAgentUrl', () => {
    expect(buildChatApiUrl('http://localhost:8002', undefined))
      .toBe('http://localhost:8002/api/chat')
  })

  it('works with empty string base URL (same-origin)', () => {
    expect(buildChatApiUrl('', 'proj_1'))
      .toBe('/api/projects/proj_1/chat')
  })

  it('prefers localAgentUrl over projectId', () => {
    expect(buildChatApiUrl('http://api.example.com', 'proj_1', 'http://local:3000'))
      .toBe('http://local:3000/agent/chat')
  })

  it('handles null localAgentUrl same as undefined', () => {
    expect(buildChatApiUrl('http://localhost:8002', 'proj_1', null))
      .toBe('http://localhost:8002/api/projects/proj_1/chat')
  })
})

describe('buildChatTurnUrl', () => {
  it('builds turn URL for a project', () => {
    expect(buildChatTurnUrl('http://localhost:8002', 'proj_1', null, 'session_abc'))
      .toBe('http://localhost:8002/api/projects/proj_1/chat/session_abc/turn')
  })

  it('builds turn URL with local agent', () => {
    expect(buildChatTurnUrl('', undefined, 'http://local:3000', 'sess_1'))
      .toBe('http://local:3000/agent/chat/sess_1/turn')
  })

  it('encodes special characters in session ID', () => {
    expect(buildChatTurnUrl('http://api.test', 'proj_1', null, 'sess/special&id'))
      .toBe('http://api.test/api/projects/proj_1/chat/sess%2Fspecial%26id/turn')
  })

  it('strips trailing slashes from the computed chat base', () => {
    expect(buildChatTurnUrl('http://api.test', 'proj_1', null, 'sess_1'))
      .toBe('http://api.test/api/projects/proj_1/chat/sess_1/turn')
  })

  it('works without projectId or localAgentUrl', () => {
    expect(buildChatTurnUrl('http://api.test', undefined, null, 'sess_1'))
      .toBe('http://api.test/api/chat/sess_1/turn')
  })
})
