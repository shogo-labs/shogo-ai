// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import { LiveTurnGate } from '../live-turn-wait'

const frame = (text: string) => new TextEncoder().encode(`data: ${JSON.stringify({ type: 'text-delta', delta: text })}\n\n`)

describe('LiveTurnGate', () => {
  test('a chat with no turn, or a finished one, is free', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    expect(gate.isBusy('s')).toBe(false)
    store.create('s').complete()
    expect(gate.isBusy('s')).toBe(false)
    expect((await gate.waitUntilFree('s')).waitedMs).toBeLessThan(5)
    store.dispose()
  })

  test('a second turn waits for the live one, which keeps every frame', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const live = store.create('s')
    live.append(frame('a'))
    expect(gate.isBusy('s')).toBe(true)

    let freed = false
    const waiting = gate.waitUntilFree('s').then((r) => {
      freed = true
      return r
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(freed).toBe(false)
    expect(live.append(frame('b'))).toBe(2)

    live.complete()
    const result = await waiting
    expect(result.stopped).toBe(false)
    expect(store.snapshot('s')?.lastSeq).toBe(2)
    store.dispose()
  })

  test('two waiters start one at a time', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const first = store.create('s')
    const started: string[] = []
    const start = (name: string) =>
      gate.waitUntilFree('s').then(() => {
        started.push(name)
        return store.create('s')
      })
    const b = start('b')
    const c = start('c')
    first.complete()
    const bWriter = await Promise.race([b, c])
    await new Promise((r) => setTimeout(r, 30))
    expect(started).toHaveLength(1)
    bWriter.complete()
    await Promise.all([b, c])
    expect(started).toHaveLength(2)
    store.dispose()
  })

  test('a stopped turn is not waited for', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    store.create('s')
    gate.markStopped('s')
    expect(gate.isBusy('s')).toBe(false)
    store.dispose()
  })

  test('Stop cancels a turn that was already waiting', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    store.create('s')
    const waiting = gate.waitUntilFree('s')
    await new Promise((r) => setTimeout(r, 20))
    gate.markStopped('s')
    expect((await waiting).stopped).toBe(true)
    store.dispose()
  })

  test('chats do not wait for each other', () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    store.create('a')
    expect(gate.isBusy('b')).toBe(false)
    store.dispose()
  })
})
