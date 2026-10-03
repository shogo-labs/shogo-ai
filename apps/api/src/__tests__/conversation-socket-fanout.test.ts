// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../services/conversation.service', () => ({
  loadAccess: async () => ({ conversation: { workspaceId: 'ws-1' } }),
  conversationAudience: async () => null,
}))
mock.module('../services/conversation-presence', () => ({
  recordPresence: async () => {},
  registerPresenceSocket: () => {},
}))

const bus = await import('../lib/conversation-bus')
const { _conversationSocketHubs, conversationSocketHandlers, isConversationSocketData } = await import('../realtime/conversation-socket')

let server: ReturnType<typeof Bun.serve>
let publishes = 0
const open: WebSocket[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      const broadcaster = {
        publish: (topic: string, data: string) => {
          publishes++
          return srv.publish(topic, data)
        },
      }
      const data = {
        kind: 'conversation-rt',
        userId: url.searchParams.get('user')!,
        userName: 'x',
        workspaceId: 'ws-1',
        server: url.searchParams.has('nobroadcast') ? undefined : broadcaster,
      }
      if (srv.upgrade(req, { data })) return undefined as any
      return new Response('no', { status: 400 })
    },
    websocket: {
      open: (ws) => isConversationSocketData(ws.data) && conversationSocketHandlers.open(ws),
      message: (ws, m) => isConversationSocketData(ws.data) && void conversationSocketHandlers.message(ws, m as any),
      close: (ws) => isConversationSocketData(ws.data) && conversationSocketHandlers.close(ws),
    },
  })
})

afterAll(() => server.stop(true))

beforeEach(async () => {
  for (const ws of open.splice(0)) ws.close()
  await until(() => _conversationSocketHubs().size === 0)
  await bus._resetConversationBusForTests(null)
  publishes = 0
})

async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await Bun.sleep(5)
  expect(fn()).toBe(true)
}

function connect(user: string, opts: { broadcast?: boolean } = {}): Promise<{ frames: any[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/?user=${user}${opts.broadcast === false ? '&nobroadcast' : ''}`)
    const frames: any[] = []
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data))
      if (frame.type === 'ready') resolve({ frames })
      else frames.push(frame)
    }
    open.push(ws)
  })
}

describe('realtime fan-out', () => {
  test('events for the whole workspace go out as one broadcast to every socket', async () => {
    const [a1, a2, b, c] = await Promise.all([connect('a'), connect('a'), connect('b'), connect('c')])
    bus.publishConversationEvent('ws-1', { type: 'message.created', conversationId: 'c1', n: 1 })
    await until(() => [a1, a2, b, c].every((s) => s.frames.length === 1))
    expect(publishes).toBe(1)
    expect(c.frames[0]).toEqual({ type: 'message.created', conversationId: 'c1', n: 1 })
  })

  test('audience-limited events reach only that audience', async () => {
    const [a, b, c] = await Promise.all([connect('a'), connect('b'), connect('c')])
    bus.publishConversationEvent('ws-1', { type: 'message.created', conversationId: 'dm', n: 2 }, ['a', 'b'])
    await until(() => a.frames.length === 1 && b.frames.length === 1)
    await Bun.sleep(30)
    expect(c.frames).toEqual([])
    expect(publishes).toBe(0)
  })

  test('typing is broadcast too; clients drop their own', async () => {
    const [a, b] = await Promise.all([connect('a'), connect('b')])
    bus.publishConversationEvent('ws-1', { type: 'typing', conversationId: 'c1', userId: 'a', name: 'A' })
    await until(() => a.frames.length === 1 && b.frames.length === 1)
    expect(publishes).toBe(1)
  })

  test("without a broadcaster, events go socket by socket and typing skips the typist's sockets", async () => {
    const [a1, a2, b] = await Promise.all([
      connect('a', { broadcast: false }),
      connect('a', { broadcast: false }),
      connect('b', { broadcast: false }),
    ])
    bus.publishConversationEvent('ws-1', { type: 'typing', conversationId: 'c1', userId: 'a', name: 'A' })
    bus.publishConversationEvent('ws-1', { type: 'message.created', conversationId: 'c1', n: 3 })
    await until(() => b.frames.length === 2 && a1.frames.length === 1 && a2.frames.length === 1)
    expect(a1.frames.map((f) => f.type)).toEqual(['message.created'])
    expect(publishes).toBe(0)
  })

  test('one bus listener per workspace, released with the last socket', async () => {
    await Promise.all([connect('a'), connect('b'), connect('c')])
    expect(_conversationSocketHubs().get('ws-1')).toEqual({ sockets: 3 })
    expect(bus._conversationBusSubscribedWorkspaces()).toEqual(['ws-1'])
    for (const ws of open.splice(0)) ws.close()
    await until(() => _conversationSocketHubs().size === 0)
    expect(bus._conversationBusSubscribedWorkspaces()).toEqual([])
  })
})
