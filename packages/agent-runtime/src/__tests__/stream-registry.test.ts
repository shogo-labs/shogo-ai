// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A buffered turn whose model call never settles used to keep `activeStreams`
 * at 1 forever: the host saw "busy", never suspended/resumed the guest, and so
 * its expired AI-proxy token was never refreshed (SHO-348, the Odin incident).
 *
 * These tests pin the fix: streams are owned, progress is observable, and a
 * turn with no turn lock and no progress is reaped — while a turn that still
 * holds its lock is never touched, however quiet it is.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { StreamBufferStore } from '@shogo/shared-runtime'
import { LiveTurnGate } from '../live-turn-wait'
import { createBufferedTurns } from '../buffered-turn'
import { StreamRegistry, DEFAULT_STREAM_ORPHAN_TTL_MS } from '../stream-registry'

const decoder = new TextDecoder()

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out += decoder.decode(value)
  }
}

let store: StreamBufferStore | undefined
afterEach(() => {
  store?.dispose()
  store = undefined
})

function setup(opts: { ttlMs?: number } = {}) {
  store = new StreamBufferStore()
  const gate = new LiveTurnGate(store, 5)
  let now = 1_000_000
  const locked = new Set<string>()
  const logs: string[] = []
  const aborted: string[] = []
  const registry = new StreamRegistry({
    isTurnLocked: (sessionId) => locked.has(sessionId),
    orphanTtlMs: opts.ttlMs ?? DEFAULT_STREAM_ORPHAN_TTL_MS,
    now: () => now,
    log: (line) => logs.push(line),
  })
  const turns = createBufferedTurns({
    store,
    gate,
    abortTurn: (sessionId) => {
      aborted.push(sessionId)
    },
    onStreamStart: (handle) => registry.register(handle),
    onStreamProgress: (turnId) => registry.touch(turnId),
    onStreamEnd: (turnId) => registry.end(turnId),
  })
  return {
    registry,
    turns,
    logs,
    aborted,
    locked,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('stream registry', () => {
  test('a wedged turn with no turn lock is reaped after the TTL', async () => {
    const { registry, turns, logs, aborted, advance } = setup({ ttlMs: 10 * 60_000 })

    // `run` never settles: exactly the dead-socket-after-restore case.
    turns.start('chat-wedged', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 10))
    expect(registry.size).toBe(1)

    advance(9 * 60_000)
    expect(registry.reapOrphans()).toEqual([])
    expect(registry.size).toBe(1)

    advance(2 * 60_000)
    const reaped = registry.reapOrphans()
    expect(reaped).toHaveLength(1)
    expect(registry.size).toBe(0)
    expect(registry.liveCount()).toBe(0)

    // The model call was told to stop and the reason was logged loudly.
    expect(aborted).toEqual(['chat-wedged'])
    expect(logs.join('\n')).toContain('reaped orphan stream')
    expect(logs.join('\n')).toContain('chat-wedged')

    // The buffer carries a terminal frame, so a reconnecting client stops
    // replaying the tail and the composer is not stuck on Stop/Queue.
    const replay = await readAll(store!.createReplayStream('chat-wedged', { fromSeq: 0, compact: false })!)
    expect(replay).toContain('data-turn-complete')
    expect(replay).toContain('reaped')
    expect(store!.snapshot('chat-wedged')?.status).toBe('completed')
  })

  test('a turn that still holds its turn lock is never reaped, however quiet', async () => {
    const { registry, turns, locked, advance } = setup({ ttlMs: 10 * 60_000 })

    locked.add('chat-long')
    turns.start('chat-long', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 10))

    advance(6 * 60 * 60_000)
    expect(registry.reapOrphans()).toEqual([])
    expect(registry.size).toBe(1)
    expect(registry.liveCount()).toBe(1)
    expect(store!.snapshot('chat-long')?.status).toBe('active')
  })

  test('buffer progress keeps a turn alive even after its lock is released', async () => {
    const { registry, turns, advance } = setup({ ttlMs: 60_000 })

    const turn = turns.start('chat-progress', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 10))

    advance(50_000)
    registry.touch(turn.turnId) // the turn is still writing to its buffer
    advance(50_000)
    expect(registry.reapOrphans()).toEqual([])
    expect(registry.size).toBe(1)

    advance(20_000)
    expect(registry.reapOrphans()).toHaveLength(1)
  })

  test('end() is idempotent and a reaped turn is already gone', async () => {
    const { registry, turns } = setup()
    const turn = turns.start('chat-done', async () => ({ aborted: false }))
    await turn.done
    registry.end(turn.turnId)
    registry.end(turn.turnId)
    expect(registry.size).toBe(0)
    expect(registry.reapOrphans()).toEqual([])
  })
})
