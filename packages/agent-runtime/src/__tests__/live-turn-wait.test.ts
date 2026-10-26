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

  test('a bounded wait gives up instead of waiting for a turn that never ends', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const live = store.create('s')

    const startedAt = Date.now()
    const result = await Promise.race([
      gate.waitUntilFree('s', { timeoutMs: 25 }),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2_000)),
    ])

    expect(result).not.toBe('hung')
    expect(result).toMatchObject({ stopped: false, timedOut: true })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(gate.isBusy('s')).toBe(true)
    live.complete()
    store.dispose()
  })

  test('without a budget it still waits for the live turn', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const live = store.create('s')
    const waiting = gate.waitUntilFree('s')
    live.complete()
    expect(await waiting).toMatchObject({ stopped: false, timedOut: false })
    store.dispose()
  })

  test('a waiter is reported as queued until its turn starts', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const live = store.create('s')
    expect(gate.queued('s')).toBeNull()

    const first = gate.waitUntilFree('s')
    await new Promise((r) => setTimeout(r, 20))
    const queued = gate.queued('s')
    expect(queued?.depth).toBe(1)
    expect(typeof queued?.since).toBe('number')

    const second = gate.waitUntilFree('s')
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.queued('s')?.depth).toBe(2)

    live.complete()
    await Promise.all([first, second])
    expect(gate.queued('s')).toBeNull()
    store.dispose()
  })
})

/**
 * A named call's progress is the only way the turn probe can answer for that
 * call: "the chat has a waiter" is also true for another window's message, and
 * the chat's live turn is not the call's turn.
 */
describe('LiveTurnGate call state', () => {
  test('a queued call is queued, then names the turn it started', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    store.create('s')

    expect(gate.callState('s', 'run-1')).toBeNull()
    gate.noteCallQueued('s', 'run-1')
    const queued = gate.callState('s', 'run-1')
    expect(typeof queued?.queuedSince).toBe('number')
    expect(queued?.turnId).toBeUndefined()

    gate.noteCallStarted('s', 'run-1', 't-1')
    expect(gate.callState('s', 'run-1')).toMatchObject({ turnId: 't-1' })
    expect(gate.callState('s', 'run-1')?.queuedSince).toBeUndefined()
    // Another call, and another chat, are unaffected.
    expect(gate.callState('s', 'run-2')).toBeNull()
    expect(gate.callState('other', 'run-1')).toBeNull()
    store.dispose()
  })

  test('a stop before the call started is recorded as stopped', () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    gate.noteCallQueued('s', 'run-1')
    gate.noteCallStopped('s', 'run-1')
    expect(gate.callState('s', 'run-1')).toEqual({ stopped: true })
    store.dispose()
  })

  test('re-queueing keeps the original wait start', () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    gate.noteCallQueued('s', 'run-1')
    const first = gate.callState('s', 'run-1')!.queuedSince
    gate.noteCallQueued('s', 'run-1')
    expect(gate.callState('s', 'run-1')!.queuedSince).toBe(first!)
    store.dispose()
  })
})
