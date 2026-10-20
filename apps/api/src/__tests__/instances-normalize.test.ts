// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The tunnel relay's path normalization decides whether a relayed request
 * streams. A workspace agent turn is the same SSE surface as a project one, so
 * `/api/workspaces/:id/agent-proxy/agent/chat` has to normalize to `/agent/chat`
 * — otherwise the relay buffers the whole turn (SHO-87).
 */

import { describe, test, expect } from 'bun:test'
import { isStreamingRequest, normalizeTransparentProxyPath } from '../routes/instances'

describe('normalizeTransparentProxyPath', () => {
  test('unwraps a project agent-proxy path', () => {
    expect(normalizeTransparentProxyPath('/api/projects/p-1/agent-proxy/agent/chat')).toBe(
      '/agent/chat',
    )
  })

  test('unwraps a workspace agent-proxy path', () => {
    expect(normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/chat')).toBe(
      '/agent/chat',
    )
    expect(
      normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/canvas/stream'),
    ).toBe('/agent/canvas/stream')
  })

  test('a bare agent-proxy wrapper becomes the runtime root', () => {
    expect(normalizeTransparentProxyPath('/api/projects/p-1/agent-proxy')).toBe('/agent')
    expect(normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy')).toBe('/agent')
  })

  test('drops the query string and leaves unwrapped paths untouched', () => {
    expect(normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/chat?x=1')).toBe(
      '/agent/chat',
    )
    expect(normalizeTransparentProxyPath('/api/workspaces/ws-1/conversations')).toBe(
      '/api/workspaces/ws-1/conversations',
    )
  })
})

describe('isStreamingRequest', () => {
  test('a workspace agent turn streams', () => {
    expect(
      isStreamingRequest('POST', normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/chat')),
    ).toBe(true)
    expect(
      isStreamingRequest(
        'GET',
        normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/canvas/stream'),
      ),
    ).toBe(true)
    expect(
      isStreamingRequest(
        'GET',
        normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/chat/sess-1/stream'),
      ),
    ).toBe(true)
  })

  test('plain workspace reads stay buffered', () => {
    expect(
      isStreamingRequest('GET', normalizeTransparentProxyPath('/api/workspaces/ws-1/agent-proxy/agent/health')),
    ).toBe(false)
    expect(isStreamingRequest('GET', '/api/workspaces/ws-1/conversations')).toBe(false)
    expect(isStreamingRequest('POST', '/api/projects/p-1/agent-proxy/agent/quick-actions')).toBe(false)
  })

  test("a workspace's team-chat event stream streams", () => {
    // The SSE the team chat subscribes to. Buffered, the relay would hold it
    // until the 30 s proxy timeout and deliver nothing, so a machine
    // workspace's chat would never receive a live message.
    expect(isStreamingRequest('GET', '/api/workspaces/ws-1/conversations/events')).toBe(true)
    expect(
      isStreamingRequest('GET', normalizeTransparentProxyPath('/api/workspaces/ws-1/conversations/events')),
    ).toBe(true)
    // …and only that endpoint under `conversations`: the list itself is a
    // normal read.
    expect(isStreamingRequest('GET', '/api/workspaces/ws-1/conversations/events/extra')).toBe(false)
    expect(isStreamingRequest('POST', '/api/workspaces/ws-1/conversations/events')).toBe(false)
  })
})
