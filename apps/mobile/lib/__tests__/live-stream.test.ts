// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import { LiveStreamClient, toWsBase } from '../live-stream'
import { FakeSocket } from './fake-socket'

const ticket = async (n = 0) => ({ ticket: `t${n}`, path: '/api/meetings/live-stream', backend: 'openai' })
const frame = (samples = 1600) => new Int16Array(samples).fill(100)

beforeEach(() => FakeSocket.reset())

describe('toWsBase', () => {
  test('swaps the scheme and trims slashes', () => {
    expect(toWsBase('https://api.shogo.ai/')).toBe('wss://api.shogo.ai')
    expect(toWsBase('http://localhost:8002')).toBe('ws://localhost:8002')
  })
})

describe('LiveStreamClient', () => {
  test('connects with a ticket, streams audio, and delivers partials and finals', async () => {
    const partials: string[] = []
    const finals: string[] = []
    const client = await LiveStreamClient.connect({
      getTicket: ticket,
      wsBase: 'wss://api',
      WebSocketImpl: FakeSocket,
      handlers: { onPartial: (m) => partials.push(m.text), onFinal: (m) => finals.push(m.segment.text) },
    })
    expect(client).not.toBeNull()
    expect(FakeSocket.last.url).toBe('wss://api/api/meetings/live-stream?ticket=t0&offset=0')

    client!.sendPcm(frame())
    expect(FakeSocket.last.sent).toHaveLength(1)
    FakeSocket.last.receive({ type: 'partial', itemId: 'a', text: 'hello wor', start: 0 })
    FakeSocket.last.receive({ type: 'final', itemId: 'a', segment: { start: 0, end: 1, text: 'hello world' } })
    expect(partials).toEqual(['hello wor'])
    expect(finals).toEqual(['hello world'])
  })

  test('finish flushes the recognizer and returns the coverage summary', async () => {
    const client = (await LiveStreamClient.connect({ getTicket: ticket, wsBase: 'ws://x', WebSocketImpl: FakeSocket }))!
    client.sendPcm(frame(16000))
    expect(await client.finish()).toEqual({ complete: true, chunks: 2, seconds: 1 })
    expect(JSON.parse(FakeSocket.last.sent.at(-1) as string)).toEqual({ type: 'finish' })
  })

  test('resolves null (so the caller uses chunks) when the server refuses or is silent', async () => {
    FakeSocket.reset('error')
    expect(await LiveStreamClient.connect({ getTicket: ticket, wsBase: 'ws://x', WebSocketImpl: FakeSocket })).toBeNull()
    FakeSocket.reset('silent')
    expect(await LiveStreamClient.connect({ getTicket: ticket, wsBase: 'ws://x', WebSocketImpl: FakeSocket, connectTimeoutMs: 20 })).toBeNull()
    expect(
      await LiveStreamClient.connect({
        getTicket: async () => {
          throw new Error('501')
        },
        wsBase: 'ws://x',
        WebSocketImpl: FakeSocket,
      }),
    ).toBeNull()
  })

  test('a dropped socket reconnects with a fresh ticket, resumes the timeline, and replays held audio', async () => {
    let n = 0
    const client = (await LiveStreamClient.connect({
      getTicket: () => ticket(++n),
      wsBase: 'ws://x',
      WebSocketImpl: FakeSocket,
    }))!
    client.sendPcm(frame(16000))
    FakeSocket.last.drop()
    client.sendPcm(frame(8000)) // spoken while disconnected
    for (let i = 0; i < 40 && FakeSocket.instances.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    expect(FakeSocket.instances).toHaveLength(2)
    // The new stream starts where the delivered audio ended (1 s), and gets the held half second.
    expect(FakeSocket.last.url).toContain('ticket=t2')
    expect(FakeSocket.last.url).toContain('offset=1')
    expect(FakeSocket.last.audioSeconds()).toBe(0.5)
    expect((await client.finish()).complete).toBe(true)
  })

  test('a fatal server error stops the stream and tells the caller', async () => {
    const fatal: string[] = []
    const client = (await LiveStreamClient.connect({
      getTicket: ticket,
      wsBase: 'ws://x',
      WebSocketImpl: FakeSocket,
      handlers: { onFatal: (m) => fatal.push(m) },
    }))!
    FakeSocket.last.receive({ type: 'error', code: 'backend_error', message: 'recognizer died', fatal: true })
    expect(fatal).toEqual(['recognizer died'])
    const sentBefore = FakeSocket.last.sent.length
    client.sendPcm(frame())
    expect(FakeSocket.last.sent).toHaveLength(sentBefore)
    expect((await client.finish()).complete).toBe(false)
  })

  test('a non-fatal error means the transcript is incomplete', async () => {
    const client = (await LiveStreamClient.connect({ getTicket: ticket, wsBase: 'ws://x', WebSocketImpl: FakeSocket }))!
    FakeSocket.last.receive({ type: 'error', code: 'backend_error', message: 'hiccup', fatal: false })
    expect((await client.finish()).complete).toBe(false)
  })

  test('abort closes the socket', async () => {
    const client = (await LiveStreamClient.connect({ getTicket: ticket, wsBase: 'ws://x', WebSocketImpl: FakeSocket }))!
    client.abort()
    expect(FakeSocket.last.closed).toBe(true)
  })
})
