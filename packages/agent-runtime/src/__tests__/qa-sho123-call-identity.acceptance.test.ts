// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-123 acceptance — QA. A call queued behind a chat's own live turn is
 * answered **by its own name**, so a follower never mistakes the turn it is
 * waiting behind for the turn it asked for.
 *
 * Composed the way the runtime wires it: the real `StreamBufferStore`, the real
 * `LiveTurnGate` and the real `createBufferedTurns`, driven through
 * `describeTurn` exactly as `GET /agent/chat/:id/turn` calls it — so the
 * `queued` → `own turn` → `completed` sequence is measured end to end, not
 * asserted from each unit separately.
 */

import { describe, test, expect } from 'bun:test'
import { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import { LiveTurnGate } from '../live-turn-wait'
import { createBufferedTurns } from '../buffered-turn'
import { describeTurn } from '../turn-status'

const enc = new TextEncoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The probe the route serves for a named call. */
function probe(store: StreamBufferStore, gate: LiveTurnGate, chat: string, callId?: string) {
  return describeTurn(store, chat, gate.queued(chat), callId ? { callId, state: gate.callState(chat, callId) } : null)
}

describe('a call queued behind the chat’s own live turn', () => {
  test('answers `queued` by name, then the turn it got — never the chat’s own turn', async () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const turns = createBufferedTurns({ store, gate })

    // The chat's own turn, started by a person.
    const own = store.create('c1')
    own.append(enc.encode(`data: {"type":"text-delta","delta":"the user"}\n\n`))

    let queuedHooks = 0
    let startedHooks = 0
    let release: () => void = () => {}
    const hold = new Promise<void>((r) => { release = r })
    const pending = turns.runPipelineCall(
      async (opts) => {
        await hold
        return { reply: 'the call answer', sessionId: opts.sessionId ?? 'c1', runId: 'run-1' }
      },
      { message: 'job', sessionId: 'c1', callId: 'call-1' },
      { onQueued: () => { queuedHooks += 1 }, onTurnStarted: () => { startedHooks += 1 } },
    )

    // While the person's turn is live: the call's answer is `queued`, even
    // though the chat has an `active` snapshot with a `createdAt` of its own.
    let whileQueued = probe(store, gate, 'c1', 'call-1')
    for (let i = 0; i < 50 && whileQueued.body.status !== 'queued'; i++) {
      await sleep(5)
      whileQueued = probe(store, gate, 'c1', 'call-1')
    }
    expect(whileQueued.body.status).toBe('queued')
    expect(whileQueued.body.callId).toBe('call-1')
    expect(whileQueued.body.turnId).toBeUndefined()
    expect(queuedHooks).toBe(1)
    expect(startedHooks).toBe(0)

    // The person's turn ends; the call gets a turn of its own.
    own.complete()
    let ownTurn: Record<string, unknown> | null = null
    for (let i = 0; i < 200; i++) {
      const p = probe(store, gate, 'c1', 'call-1')
      if (p.body.status !== 'queued') {
        ownTurn = p.body
        break
      }
      await sleep(10)
    }
    expect(startedHooks).toBe(1)
    expect(ownTurn).not.toBeNull()
    expect(ownTurn!.callId).toBe('call-1')
    // The turn the call got is its own — not the person's.
    expect(ownTurn!.turnId).toBeTruthy()
    expect(ownTurn!.turnId).not.toBe(own.turnId)
    expect(ownTurn!.status).toBe('active')

    release()
    await pending
    const after = probe(store, gate, 'c1', 'call-1')
    expect(after.body.status).toBe('completed')
    expect(after.body.turnId).toBe(ownTurn!.turnId)
    store.dispose()
  }, 20_000)

  test('control: the chat’s own turn is still reported when no call is named', () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const own = store.create('c2')
    own.append(enc.encode(`data: {"type":"text-delta","delta":"hello"}\n\n`))

    const plain = probe(store, gate, 'c2')
    expect(plain.body.status).toBe('active')
    expect(plain.body.turnId).toBe(own.turnId)
    expect(plain.body.callId).toBeUndefined()

    own.complete()
    store.dispose()
  })

  test('a call the gate never heard of is `lost` — the loss the follower fails on', () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const lost = probe(store, gate, 'c3', 'call-never-queued')
    expect(lost.body.status).toBe('lost')
    expect(lost.body.callId).toBe('call-never-queued')
    store.dispose()
  })

  test('a queued call whose chat is stopped is `lost` with the reason', () => {
    const store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    gate.noteCallQueued('c4', 'call-4')
    expect(probe(store, gate, 'c4', 'call-4').body.status).toBe('queued')

    gate.noteCallStopped('c4', 'call-4')
    const stopped = probe(store, gate, 'c4', 'call-4')
    expect(stopped.body.status).toBe('lost')
    expect(stopped.body.reason).toBe('stopped')
    store.dispose()
  })
})
