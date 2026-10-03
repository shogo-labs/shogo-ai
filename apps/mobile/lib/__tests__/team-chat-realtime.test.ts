// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { TeamChatConnection } from '../team-chat-realtime'

class FakeSocket {
  sent: string[] = []
  closed = false
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  drop() { this.onclose?.() }
}

class FakeSource {
  closed = false
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  close() { this.closed = true }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

function harness() {
  const sockets: FakeSocket[] = []
  const sources: FakeSource[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const connection = new TeamChatConnection({
    urls: { ws: 'ws://api/rt', sse: 'http://api/events' },
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    createEventSource: () => { const s = new FakeSource(); sources.push(s); return s },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimeout: (t) => { (t as { cleared: boolean }).cleared = true },
    setInterval: () => ({}),
    clearInterval: () => {},
  })
  const runNextTimer = () => {
    const t = timers.find((x) => !x.cleared)
    if (!t) throw new Error('no pending timer')
    t.cleared = true
    t.fn()
    return t.ms
  }
  return { connection, sockets, sources, timers, runNextTimer }
}

describe('TeamChatConnection', () => {
  test('opens on ready, forwards events, and sends typing/presence upstream', () => {
    const { connection, sockets } = harness()
    const events: string[] = []
    connection.on((e) => events.push(e.type))
    connection.start()
    expect(connection.state).toBe('connecting')
    connection.sendTyping('c1')
    expect(sockets[0].sent).toHaveLength(0)

    sockets[0].receive({ type: 'ready', workspaceId: 'w1', userId: 'u1' })
    sockets[0].receive({ type: 'message.created', conversationId: 'c1', message: {} })
    sockets[0].receive({ type: 'pong' })
    expect(connection.state).toBe('open')
    expect(events).toEqual(['ready', 'message.created'])

    connection.sendTyping('c1', 'root')
    connection.setPresence('away')
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'typing', conversationId: 'c1', threadRootId: 'root' },
      { type: 'presence', status: 'away' },
    ])
  })

  test('reconnects after a drop and re-announces away presence', () => {
    const { connection, sockets, runNextTimer } = harness()
    connection.start()
    sockets[0].receive({ type: 'ready' })
    connection.setPresence('away')
    sockets[0].drop()
    expect(runNextTimer()).toBe(1000)
    expect(sockets).toHaveLength(2)
    sockets[1].receive({ type: 'ready' })
    expect(sockets[1].sent.map((s) => JSON.parse(s))).toEqual([{ type: 'presence', status: 'away' }])
  })

  test('falls back to SSE when sockets never connect, then returns to the socket', () => {
    const { connection, sockets, sources, runNextTimer } = harness()
    const events: string[] = []
    connection.on((e) => events.push(e.type))
    connection.start()
    sockets[0].drop()
    expect(sources).toHaveLength(0)
    runNextTimer()
    sockets[1].drop()
    expect(sources).toHaveLength(1)
    expect(connection.state).toBe('fallback')
    sources[0].receive({ type: 'ready' })
    sources[0].receive({ type: 'reaction.changed', messageId: 'm', reactions: [] })
    expect(events).toEqual(['ready', 'reaction.changed'])

    expect(runNextTimer()).toBe(60_000)
    sockets[2].receive({ type: 'ready' })
    expect(connection.state).toBe('open')
    expect(sources[0].closed).toBe(true)
  })

  test('stop closes everything and cancels retries', () => {
    const { connection, sockets, timers } = harness()
    connection.start()
    sockets[0].receive({ type: 'ready' })
    sockets[0].drop()
    connection.stop()
    expect(connection.state).toBe('closed')
    expect(timers.every((t) => t.cleared)).toBe(true)
  })
})
