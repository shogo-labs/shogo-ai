// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { ChatLatency } from '../chat-latency'
import { captureWake, reportWake } from '../wake-capture'

const enc = (s: string) => new TextEncoder().encode(s)

function fakeSpan() {
  const attrs: Record<string, unknown> = {}
  return { attrs, setAttribute: (k: string, v: unknown) => ((attrs[k] = v), undefined) } as any
}

describe('ChatLatency', () => {
  it('ignores start frames and keepalives, then records the first rendered frame', () => {
    const l = new ChatLatency('workspace')
    l.observe(enc('data: {"type":"start","messageId":"m1"}\n\n'))
    l.observe(enc(': proxy-keep-alive\n\n'))
    l.observe(enc('data: {"type":"start-step"}\n\n'))
    expect(l.ttftMs).toBeUndefined()
    l.observe(enc('data: {"type":"text-delta","id":"t","delta":"Hi"}\n\n'))
    expect(l.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('finds a content frame split across chunks', () => {
    const l = new ChatLatency('project')
    l.observe(enc('data: {"type":"reasoning-'))
    expect(l.ttftMs).toBeUndefined()
    l.observe(enc('delta","id":"r","delta":"thinking"}\n\n'))
    expect(l.ttftMs).toBeDefined()
  })

  it('counts an error frame as the first thing the user sees', () => {
    const l = new ChatLatency('project')
    l.observe(enc('data: {"type":"error","errorText":"boom"}\n\n'))
    expect(l.ttftMs).toBeDefined()
  })

  it('stamps the wake and the runtime-reported gateway wait on the span', () => {
    const span = fakeSpan()
    const l = new ChatLatency('workspace', span)
    l.resolved({ mode: 'assigned', source: 'none', staleReason: 'member_data', idleTier: 'aggressive' })
    l.upstreamHeaders(new Response(null, { headers: { 'x-shogo-gateway-wait-ms': '4200' } }))
    expect(span.attrs['wake.mode']).toBe('assigned')
    expect(span.attrs['wake.stale_reason']).toBe('member_data')
    expect(span.attrs['idle.tier']).toBe('aggressive')
    expect(span.attrs['chat.gateway_wait_ms']).toBe(4200)
  })

  it('leaves gateway wait unset when the runtime predates the header', () => {
    const span = fakeSpan()
    new ChatLatency('project', span).upstreamHeaders(new Response(null))
    expect(span.attrs).not.toHaveProperty('chat.gateway_wait_ms')
  })
})

describe('captureWake', () => {
  it('returns what the resolver reported, across awaits', async () => {
    const { value, wake } = await captureWake(async () => {
      await Bun.sleep(1)
      reportWake({ mode: 'resumed', source: 'local' })
      return 'url'
    })
    expect(value).toBe('url')
    expect(wake).toEqual({ mode: 'resumed', source: 'local' })
  })

  it('is empty when nothing reported, and reporting outside a capture is a no-op', async () => {
    reportWake({ mode: 'stray' })
    expect((await captureWake(async () => 1)).wake).toBeUndefined()
  })
})
