// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  buildPortTunnelBridgeData,
  buildRuntimePortWsUrl,
  createPortTunnelBridgeHandlers,
  isPortTunnelBridgeData,
  type PortTunnelBridgeData,
} from '../lib/port-tunnel-bridge'

/**
 * Fake outbound WebSocket — mirrors the pty-pod-bridge test's fake exactly
 * (see that file for the full rationale); the port tunnel bridge dials the
 * same shape of outbound socket, just at a different URL/auth header.
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
  data: PortTunnelBridgeData
  sent: Array<{ payload: ArrayBuffer | Uint8Array | string; binary: boolean }>
  closeArgs: { code?: number; reason?: string } | null
  send(payload: any, binary?: boolean): void
  close(code?: number, reason?: string): void
}

function makeServerWs(): FakeServerWs {
  const ws: FakeServerWs = {
    data: buildPortTunnelBridgeData({
      podUrl: 'http://proj.pod.svc',
      port: 5432,
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
  return createPortTunnelBridgeHandlers({
    WebSocketCtor: FakeOutbound as unknown as typeof WebSocket,
    logger: { error: () => {} },
  })
}

describe('buildRuntimePortWsUrl', () => {
  test('http origin → ws scheme', () => {
    expect(buildRuntimePortWsUrl('http://x.svc', 5432)).toBe('ws://x.svc/agent/ports/5432/ws')
  })
  test('https origin → wss scheme', () => {
    expect(buildRuntimePortWsUrl('https://x.svc', 8000)).toBe('wss://x.svc/agent/ports/8000/ws')
  })
  test('trims trailing slash', () => {
    expect(buildRuntimePortWsUrl('http://x.svc/', 8000)).toBe('ws://x.svc/agent/ports/8000/ws')
  })
})

describe('isPortTunnelBridgeData', () => {
  test('accepts the discriminated tag', () => {
    expect(isPortTunnelBridgeData(buildPortTunnelBridgeData({
      podUrl: 'http://x', port: 1, runtimeToken: 't',
    }))).toBe(true)
  })
  test('rejects everything else', () => {
    expect(isPortTunnelBridgeData(null)).toBe(false)
    expect(isPortTunnelBridgeData({})).toBe(false)
    expect(isPortTunnelBridgeData({ __kind: 'other' })).toBe(false)
  })
})

describe('createPortTunnelBridgeHandlers', () => {
  test('happy path: open dials runtime with token+url; frames flow both ways; closes propagate', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any

    bridge.open(ws)
    expect(instances.length).toBe(1)
    const outbound = instances[0]
    expect(outbound.url).toBe('ws://proj.pod.svc/agent/ports/5432/ws')
    expect(outbound.headers).toEqual({ 'x-runtime-token': 'token-proj' })

    outbound.triggerOpen()
    bridge.message(ws, new TextEncoder().encode('SELECT 1').buffer)
    expect(outbound.sent.length).toBe(1)

    outbound.triggerMessage(new TextEncoder().encode('row').buffer)
    expect(ws.sent.length).toBe(1)
    expect(ws.sent[0].binary).toBe(true)

    bridge.close(ws, 1000, 'client-closed')
    expect(outbound.closeArgs).toEqual({ code: 1000, reason: 'client-closed' })
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

  test('runtime closes first → close code+reason forwarded to client verbatim', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerOpen()
    outbound.triggerClose(1000, 'tcp-eof')
    expect(ws.closeArgs).toEqual({ code: 1000, reason: 'tcp-eof' })
  })

  test('runtime closes before opening → client sees 1011 runtime-unreachable', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerClose(1006, '')
    expect(ws.closeArgs?.code).toBe(1011)
    expect(ws.closeArgs?.reason).toBe('runtime-unreachable')
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

  test('client-side close before outbound opens → outbound gets clean-closed on open', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    bridge.close(ws, 1000, 'bye')
    expect(outbound.closeArgs).toEqual({ code: 1000, reason: 'bye' })
  })

  test('messages from runtime arriving after client close are dropped', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerOpen()
    bridge.close(ws, 1000, 'bye')
    outbound.triggerMessage(new TextEncoder().encode('late').buffer)
    expect(ws.sent.length).toBe(0)
  })

  test('messages from client arriving after CONNECTING fail are dropped (not queued)', () => {
    const bridge = makeBridge()
    const ws = makeServerWs() as any
    bridge.open(ws)
    const outbound = instances[0]
    outbound.triggerClose(1011, '')
    bridge.message(ws, new TextEncoder().encode('after-close').buffer)
    expect(outbound.sent.length).toBe(0)
    expect(ws.data.outboundQueue.length).toBe(0)
  })

  test('string frames from client are forwarded as strings', () => {
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

  test('dial throwing → client closed 1011 runtime-unreachable, no outbound retained', () => {
    instances = []
    const ThrowingCtor: any = function (this: any) { throw new Error('dial blew up') }
    const bridge = createPortTunnelBridgeHandlers({
      WebSocketCtor: ThrowingCtor,
      logger: { error: () => {} },
    })
    const ws = makeServerWs() as any
    bridge.open(ws)
    expect(ws.closeArgs?.code).toBe(1011)
    expect(ws.closeArgs?.reason).toBe('runtime-unreachable')
    expect(ws.data.outbound).toBe(null)
  })
})
