// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  publish,
  subscribe,
  getLastFrame,
  hasSubscribers,
  dropChannel,
  __resetForTests,
  type ScreencastFrame,
} from '../screencast-broadcaster'

function makeFrame(overrides: Partial<ScreencastFrame> = {}): ScreencastFrame {
  return {
    jpegBase64: overrides.jpegBase64 ?? 'AAAA',
    ts: overrides.ts ?? Date.now(),
    width: overrides.width ?? 1280,
    height: overrides.height ?? 720,
  }
}

describe('screencast-broadcaster', () => {
  beforeEach(() => {
    __resetForTests()
  })

  test('publish + subscribe delivers frames to listeners keyed by instanceId', () => {
    const received: ScreencastFrame[] = []
    const unsub = subscribe('agent-1', (f) => received.push(f))

    const f1 = makeFrame({ jpegBase64: 'f1' })
    const f2 = makeFrame({ jpegBase64: 'f2' })
    publish('agent-1', f1)
    publish('agent-1', f2)

    expect(received).toHaveLength(2)
    expect(received[0]!.jpegBase64).toBe('f1')
    expect(received[1]!.jpegBase64).toBe('f2')
    unsub()
  })

  test('publish does not notify listeners subscribed to a different instanceId', () => {
    const received: ScreencastFrame[] = []
    subscribe('agent-A', (f) => received.push(f))

    publish('agent-B', makeFrame({ jpegBase64: 'other' }))

    expect(received).toHaveLength(0)
  })

  test('getLastFrame returns the most recently published frame for that instanceId', () => {
    publish('agent-1', makeFrame({ jpegBase64: 'old' }))
    publish('agent-1', makeFrame({ jpegBase64: 'new' }))

    const last = getLastFrame('agent-1')
    expect(last?.jpegBase64).toBe('new')
    expect(getLastFrame('nonexistent')).toBeUndefined()
  })

  test('unsubscribe stops future delivery and is idempotent', () => {
    const received: ScreencastFrame[] = []
    const unsub = subscribe('agent-1', (f) => received.push(f))

    publish('agent-1', makeFrame({ jpegBase64: 'before' }))
    unsub()
    publish('agent-1', makeFrame({ jpegBase64: 'after' }))
    unsub() // idempotent

    expect(received).toHaveLength(1)
    expect(received[0]!.jpegBase64).toBe('before')
  })

  test('hasSubscribers reflects listener registration accurately', () => {
    expect(hasSubscribers('agent-1')).toBe(false)
    const unsub = subscribe('agent-1', () => {})
    expect(hasSubscribers('agent-1')).toBe(true)
    unsub()
    expect(hasSubscribers('agent-1')).toBe(false)
  })

  test('multiple subscribers on the same instanceId all receive every frame', () => {
    const a: ScreencastFrame[] = []
    const b: ScreencastFrame[] = []
    subscribe('agent-1', (f) => a.push(f))
    subscribe('agent-1', (f) => b.push(f))

    publish('agent-1', makeFrame({ jpegBase64: '1' }))
    publish('agent-1', makeFrame({ jpegBase64: '2' }))

    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    expect(a.map((f) => f.jpegBase64)).toEqual(['1', '2'])
    expect(b.map((f) => f.jpegBase64)).toEqual(['1', '2'])
  })

  test('a throwing listener does not break delivery to other subscribers', () => {
    const good: ScreencastFrame[] = []
    subscribe('agent-1', () => {
      throw new Error('boom')
    })
    subscribe('agent-1', (f) => good.push(f))

    expect(() => publish('agent-1', makeFrame({ jpegBase64: 'x' }))).not.toThrow()
    expect(good).toHaveLength(1)
  })

  test('dropChannel clears lastFrame + listeners for the given instanceId', () => {
    const received: ScreencastFrame[] = []
    subscribe('agent-1', (f) => received.push(f))
    publish('agent-1', makeFrame({ jpegBase64: 'x' }))

    dropChannel('agent-1')

    expect(getLastFrame('agent-1')).toBeUndefined()
    expect(hasSubscribers('agent-1')).toBe(false)

    // Publishing after drop doesn't fan out to the now-removed listener.
    publish('agent-1', makeFrame({ jpegBase64: 'y' }))
    expect(received).toHaveLength(1)
  })

  test('publish with empty instanceId is a no-op', () => {
    expect(() => publish('', makeFrame())).not.toThrow()
    expect(getLastFrame('')).toBeUndefined()
  })
})
