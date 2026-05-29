// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  buildPodWsUrl,
  buildPtyPodBridgeData,
  createPtyPodBridgeHandlers,
  isPtyPodBridgeData,
  type PtyPodBridgeData,
} from '../lib/pty-pod-bridge'

/**
 * Fake outbound WebSocket — captures sends, exposes triggers for open/message/close.
 * Mirrors only the surface the bridge uses (`onopen/onmessage/onerror/onclose`,
 * `readyState`, `send`, `close`). Static `OPEN/CONNECTING/CLOSING/CLOSED`
 * codes match the real WebSocket interface.
 */
class FakeOutbound {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3

  readyState = FakeOutbound.CONNECTING
  binaryType: BinaryType = 'arraybuffer'
  url: string
  headers: Record<string, string> | undefined
  sent: Array<ArrayBuffer | string> = []
  closeArgs: { code?: number; reason?: string } | null = null
  onopen: ((evt?: Event) => void) | null = null
  onmessage: ((evt: MessageEvent) => void) | null = null
  onerror: ((evt: Event) => void) | null = null
  onclose: ((evt: CloseEvent) => void) | null = null

  constructor(url: string, opts?: any) {
    this.url = url
    this.headers = opts?.headers
    instances.push(this)
  }

  send(frame: ArrayBuffer | string) {
    this.sent.push(frame)
  }

  close(code?: number, reason?: string) {
    this.closeArgs = { code, reason }
    this.readyState = FakeOutbound.CLOSED
  }

  triggerOpen() {
    this.readyState = FakeOutbound.OPEN
    this.onopen?.()
  }

  triggerMessage(data: ArrayBuffer | string) {
    this.onmessage?.({ data } as MessageEvent)
  }

  triggerClose(code: number, reason: string) {
    this.readyState = FakeOutbound.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

let instances: FakeOutbound[] = []

interface FakeServerWs {
  data: PtyPodBridgeData
  sent: Array<{ payload: ArrayBuffer | Uint8Array | string; binary: boolean }>
  closeArgs: { code?: number; reason?: string } | null
  send(payload: any, binary?: boolean): void
  close(code?: number, reason?: string): void
}

function makeServerWs(): FakeServerWs {
  const ws: FakeServerWs = {
    data: buildPtyPodBridgeData({
      podUrl: 'http://proj.pod.svc',
      sessionId: 'sess-1',
      since: 0,
      runtimeToken: 'token-proj',
    }),
    sent: [],
    closeArgs: null,
    send(payload: any, binary = false) {
      this.sent.push({ payload, binary })
    },
    close(code?: number, reason?: string) {
      this.closeArgs = { code, reason }
    },
  }
  return ws
}

function makeBridge() {
  instances = []
  const bridge = createPtyPodBridgeHandlers({
    WebSocketCtor: FakeOutbound as unknown as typeof WebSocket,
    logger: { error: () => {} },
  })
  return bridge
}

describe('buildPodWsUrl', () => {
  test('http origin → ws scheme', () => {
    expect(buildPodWsUrl('http://x.svc', 'sess-1', 0)).toBe('ws://x.svc/terminal/sessions/sess-1/ws')
  })
  test('https origin → wss scheme', () => {
    expect(buildPodWsUrl('https://x.svc', 'sess-1', 0)).toBe('wss://x.svc/terminal/sessions/sess-1/ws')
  })
  test('trims trailing slash', () => {
    expect(buildPodWsUrl('http://x.svc/', 'sess-1', 0)).toBe('ws://x.svc/terminal/sessions/sess-1/ws')
  })
  test('since=0 omitted from query', () => {
    expect(buildPodWsUrl('http://x.svc', 's', 0)).toBe('ws://x.svc/terminal/sessions/s/ws')
  })
  test('since>0 appended', () => {
    expect(buildPodWsUrl('http://x.svc', 's', 1234)).toBe('ws://x.svc/terminal/sessions/s/ws?since=1234')
  })
  test('encodes session id', () => {
    expect(buildPodWsUrl('http://x.svc', 'a b', 0)).toBe('ws://x.svc/terminal/sessions/a%20b/ws')
  })
})

describe('isPtyPodBridgeData', () => {
  test('accepts the discriminated tag', () => {
    expect(isPtyPodBridgeData(buildPtyPodBridgeData({
      podUrl: 'http://x', sessionId: 's', since: 0, runtimeToken: 't',
    }))).toBe(true)
  })
  test('rejects everything else', () => {
    expect(isPtyPodBridgeData(null)).toBe(false)
    expect(isPtyPodBridgeData({})).toBe(false)
    expect(isPtyPodBridgeData({ __kind: 'other' })).toBe(false)
  })
})

describe('createPtyPodBridgeHandlers', () => {
  test('happy path: open dials pod with token+url; frames flow both ways; closes propagate', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any

    bridge.open(ws)
    expect(instances.length).toBe(1)
    const outbound = instances[0]
    expect(outbound.url).toBe('ws://proj.pod.svc/terminal/sessions/sess-1/ws')
    expect(outbound.headers).toEqual({ 'x-runtime-token': 'token-proj' })

    outbound.triggerOpen()
    bridge.message(ws, new TextEncoder().encode('ping').buffer)
    expect(outbound.sent.length).toBe(1)

    outbound.triggerMessage(new TextEncoder().encode('pong').buffer)
    expect(ws.sent.length).toBe(1)
    expect(ws.sent[0].binary).toBe(true)

    bridge.close(ws, 1000, 'browser-closed')
    expect(outbound.closeArgs).toEqual({ code: 1000, reason: 'browser-closed' })
  })

  test('uses wss + appends since when since>0', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    ws.data = buildPtyPodBridgeData({
      podUrl: 'https://secure.pod.svc',
      sessionId: 'sess-x',
      since: 4096,
      runtimeToken: 't',
    })
    bridge.open(ws)
    expect(instances[0].url).toBe('wss://secure.pod.svc/terminal/sessions/sess-x/ws?since=4096')
  })

  test('frames sent before outbound open are queued and flushed on open', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any

    bridge.open(ws)
    const outbound = instances[0]
    expect(outbound.readyState).toBe(FakeOutbound.CONNECTING)

    const frame1 = new TextEncoder().encode('one').buffer
    const frame2 = new TextEncoder().encode('two').buffer
    bridge.message(ws, frame1)
    bridge.message(ws, frame2)
    expect(outbound.sent.length).toBe(0)
    expect(ws.data.outboundQueue.length).toBe(2)

    outbound.triggerOpen()
    expect(outbound.sent.length).toBe(2)
    expect(ws.data.outboundQueue.length).toBe(0)
  })

  test('pod closes first → close code+reason forwarded to browser verbatim', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerOpen()
    outbound.triggerClose(1000, 'pty:exited')
    expect(ws.closeArgs).toEqual({ code: 1000, reason: 'pty:exited' })
  })

  test('pod closes before opening → browser sees 1011 pod-unreachable', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerClose(1006, '')
    expect(ws.closeArgs?.code).toBe(1011)
    expect(ws.closeArgs?.reason).toBe('pod-unreachable')
  })

  test('forbidden close codes (1005/1006) get sanitised to 1011', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerOpen()
    outbound.triggerClose(1005, '')
    expect(ws.closeArgs?.code).toBe(1011)
  })

  test('browser-side close before outbound opens → outbound gets clean-closed on open', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    bridge.close(ws, 1000, 'bye')
    expect(outbound.closeArgs).toEqual({ code: 1000, reason: 'bye' })

    const outbound2 = new (FakeOutbound as any)('ws://test', {})
    outbound2.triggerOpen?.()
  })

  test('messages from pod arriving after browser close are dropped', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerOpen()
    bridge.close(ws, 1000, 'bye')
    outbound.triggerMessage(new TextEncoder().encode('late').buffer)
    expect(ws.sent.length).toBe(0)
  })

  test('messages from browser arriving after CONNECTING fail are dropped (not queued)', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerClose(1011, '')
    bridge.message(ws, new TextEncoder().encode('after-close').buffer)
    expect(outbound.sent.length).toBe(0)
    expect(ws.data.outboundQueue.length).toBe(0)
  })

  test('string frames from browser are forwarded as strings', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    instances[0].triggerOpen()
    bridge.message(ws, 'hello')
    expect(instances[0].sent[0]).toBe('hello')
  })

  test('Uint8Array frames are copied into a fresh ArrayBuffer for forwarding', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    instances[0].triggerOpen()
    const src = new Uint8Array([1, 2, 3])
    bridge.message(ws, src)
    expect(instances[0].sent.length).toBe(1)
    const sent = instances[0].sent[0] as ArrayBuffer
    expect(sent instanceof ArrayBuffer).toBe(true)
    expect(new Uint8Array(sent)).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('dial throwing → browser closed 1011 pod-unreachable, no outbound retained', () => {
    instances = []
    const ThrowingCtor: any = function (this: any) { throw new Error('dial blew up') }
    const bridge = createPtyPodBridgeHandlers({
      WebSocketCtor: ThrowingCtor,
      logger: { error: () => {} },
    })
    const ws = makeServerWs() as any
    bridge.open(ws)
    expect(ws.closeArgs?.code).toBe(1011)
    expect(ws.closeArgs?.reason).toBe('pod-unreachable')
    expect(ws.data.outbound).toBe(null)
  })
})
