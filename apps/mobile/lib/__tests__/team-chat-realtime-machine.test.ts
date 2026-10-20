// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live team chat for a paired desktop's own workspace.
 *
 * The machine's events come from the desktop through the relay. A tunnel carries
 * HTTP, not a WebSocket upgrade, so the connection has no socket URL and goes
 * straight to the SSE stream — which the relay forwards chunk by chunk
 * (`isStreamingRequest` recognises `/api/workspaces/:id/conversations/events`).
 */

import { describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

mock.module(resolve(import.meta.dir, '../api-url'), () => ({ API_URL: 'https://api.example.com' }))

const { realtimeUrls } = await import('../team-chat-api')
const { TeamChatConnection } = await import('../team-chat-realtime')

describe('realtimeUrls on a machine workspace', () => {
  const machine = { instanceId: 'inst-1', localWorkspaceId: 'lw-samsara' }

  test('points the event stream at the machine, with the machine’s own workspace id', () => {
    const urls = realtimeUrls('ws-cloud', machine)
    expect(urls.sse).toBe(
      'https://api.example.com/api/machines/inst-1/w/lw-samsara/api/workspaces/lw-samsara/conversations/events',
    )
    // No socket URL: the tunnel cannot carry a WebSocket upgrade, so the
    // connection must not pretend it has one.
    expect(urls.ws).toBe('')
  })

  test('a cloud workspace keeps both of its own URLs', () => {
    const urls = realtimeUrls('ws-cloud')
    expect(urls.ws).toContain('/api/workspaces/ws-cloud/rt')
    expect(urls.sse).toBe('https://api.example.com/api/workspaces/ws-cloud/conversations/events')
  })
})

describe('TeamChatConnection without a socket URL', () => {
  test('opens the event source immediately and never opens a socket', () => {
    const sockets: string[] = []
    const sources: string[] = []
    const connection = new TeamChatConnection({
      urls: { ws: '', sse: 'https://api.example.com/events' },
      createSocket: (url) => {
        sockets.push(url)
        throw new Error('no socket on a relayed workspace')
      },
      createEventSource: (url) => {
        sources.push(url)
        return { close() {}, onmessage: null, onerror: null }
      },
    })

    connection.start()

    expect(sockets).toEqual([])
    expect(sources).toEqual(['https://api.example.com/events'])
    expect(connection.state).toBe('fallback')
    connection.stop()
  })

  test('a workspace with a socket still tries the socket first', () => {
    const sockets: string[] = []
    const connection = new TeamChatConnection({
      urls: { ws: 'wss://api.example.com/rt', sse: 'https://api.example.com/events' },
      createSocket: (url) => {
        sockets.push(url)
        return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }
      },
      createEventSource: () => ({ close() {}, onmessage: null, onerror: null }),
    })

    connection.start()

    expect(sockets).toEqual(['wss://api.example.com/rt'])
    connection.stop()
  })
})
