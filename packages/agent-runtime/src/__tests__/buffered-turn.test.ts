// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A project_call records the callee's turn as a chat, and "Open chat" on the
 * caller's card opens it. That chat can only stream if the pipeline turn runs
 * into the chat's stream buffer, like a chat turn does.
 */
import { afterEach, describe, expect, test, jest } from 'bun:test'
import { StreamBufferStore } from '@shogo/shared-runtime'
import { LiveTurnGate } from '../live-turn-wait'
import {
  createBufferedTurns,
  isOpenableChatSession,
  startSeqHeartbeat,
  SEQ_HEARTBEAT_MS,
  SEQ_KEEPALIVE_MS,
} from '../buffered-turn'

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

let store: StreamBufferStore
afterEach(() => store?.dispose())

function setup() {
  store = new StreamBufferStore()
  const gate = new LiveTurnGate(store, 5)
  return { gate, turns: createBufferedTurns({ store, gate }) }
}

describe('pipeline calls into an openable chat', () => {
  test('the turn is live in the buffer while it runs and terminal after', async () => {
    const { turns } = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })

    const pending = turns.runPipelineCall(async (call) => {
      call.writer!.write({ type: 'text-start', id: 't1' })
      call.writer!.write({ type: 'text-delta', id: 't1', delta: 'working on it' })
      await gate
      call.writer!.write({ type: 'text-end', id: 't1' })
      return { reply: 'done', sessionId: call.sessionId!, runId: call.runId }
    }, { message: 'go', runId: 'run_1', sessionId: 'chat-1' })

    await new Promise((r) => setTimeout(r, 20))
    expect(store.snapshot('chat-1')?.status).toBe('active')

    release()
    await expect(pending).resolves.toEqual({ reply: 'done', sessionId: 'chat-1', runId: 'run_1' })
    expect(store.snapshot('chat-1')?.status).toBe('completed')

    const replay = await readAll(store.createReplayStream('chat-1', { fromSeq: 0, compact: false })!)
    expect(replay).toContain('data-turn-start')
    expect(replay).toContain('working on it')
    expect(replay).toContain('"status":"completed"')
  })

  test('a failed call is reported to the caller and ends the turn as failed', async () => {
    const { turns } = setup()
    const pending = turns.runPipelineCall(async () => {
      throw new Error('model down')
    }, { message: 'go', sessionId: 'chat-2' })

    await expect(pending).rejects.toThrow('model down')
    const replay = await readAll(store.createReplayStream('chat-2', { fromSeq: 0, compact: false })!)
    expect(replay).toContain('"status":"failed"')
  })

  test('waits for a live chat turn before starting', async () => {
    const { turns } = setup()
    const live = store.create('chat-3')
    const order: string[] = []
    const pending = turns.runPipelineCall(async (call) => {
      order.push('call')
      return { reply: 'ok', sessionId: call.sessionId! }
    }, { message: 'go', sessionId: 'chat-3' })

    await new Promise((r) => setTimeout(r, 30))
    order.push('chat done')
    live.complete()
    await pending
    expect(order).toEqual(['chat done', 'call'])
  })

  test('runtime-internal sessions run without a buffer or writer', async () => {
    const { turns } = setup()
    for (const sessionId of [undefined, 'run:run_9', 'pipeline']) {
      let writer: unknown = 'unset'
      await turns.runPipelineCall(async (call) => {
        writer = call.writer
        return { reply: 'ok', sessionId: call.sessionId ?? 'pipeline' }
      }, { message: 'go', sessionId })
      expect(writer).toBeUndefined()
      if (sessionId) expect(store.snapshot(sessionId)).toBeNull()
    }
  })

  test('keeps the call reply readable after the turn buffer is done', async () => {
    const { turns } = setup()
    const result = await turns.runPipelineCall(async (call) => {
      return { reply: 'the caller got this', sessionId: call.sessionId!, runId: call.runId }
    }, { message: 'go', runId: 'run_2', sessionId: 'chat-4' })

    expect(result.reply).toBe('the caller got this')
    expect(store.turnReply('chat-4')).toMatchObject({
      reply: 'the caller got this',
      turnId: store.snapshot('chat-4')!.turnId,
    })
  })

  test('a failed call records no reply', async () => {
    const { turns } = setup()
    await expect(
      turns.runPipelineCall(async () => {
        throw new Error('model down')
      }, { message: 'go', sessionId: 'chat-5' }),
    ).rejects.toThrow('model down')
    expect(store.turnReply('chat-5')).toBeNull()
  })
})

describe('a call into a busy chat queues instead of dropping', () => {
  test('the call runs once the chat finishes its own turn, however long that takes', async () => {
    store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const turns = createBufferedTurns({ store, gate })
    const live = store.create('busy-chat')

    const order: string[] = []
    let queued = false
    let started = false
    const pending = turns.runPipelineCall(
      async (call) => {
        order.push('call')
        return { reply: 'ran after the chat', sessionId: call.sessionId! }
      },
      { message: 'go', sessionId: 'busy-chat' },
      { onQueued: () => { queued = true }, onTurnStarted: () => { started = true } },
    )

    // Held far longer than any start budget: still queued, never failed.
    await new Promise((r) => setTimeout(r, 120))
    expect(queued).toBe(true)
    expect(started).toBe(false)
    expect(gate.queued('busy-chat')).toMatchObject({ depth: 1 })
    // The live turn is untouched, and no second buffer was created over it.
    expect(store.snapshot('busy-chat')?.turnId).toBe(live.turnId)

    order.push('chat done')
    live.complete()
    await expect(pending).resolves.toMatchObject({ reply: 'ran after the chat' })
    expect(order).toEqual(['chat done', 'call'])
    expect(started).toBe(true)
    expect(gate.queued('busy-chat')).toBeNull()
    live.complete()
  })

  test('the gate answers for the call by name: queued, then its own turn', async () => {
    store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const turns = createBufferedTurns({ store, gate })
    const live = store.create('busy-named')

    const pending = turns.runPipelineCall(
      async (call) => ({ reply: 'the call answer', sessionId: call.sessionId! }),
      { message: 'go', sessionId: 'busy-named', callId: 'run-42' },
    )

    // While the chat's own turn runs, the call is queued — and the chat's turn
    // is not offered as the call's.
    await new Promise((r) => setTimeout(r, 40))
    expect(gate.callState('busy-named', 'run-42')?.queuedSince).toBeNumber()
    expect(gate.callState('busy-named', 'run-42')?.turnId).toBeUndefined()
    expect(store.snapshot('busy-named')!.turnId).toBe(live.turnId)

    live.complete()
    await pending

    // Once the call ran, the gate names the turn it got — not the chat's.
    const started = gate.callState('busy-named', 'run-42')
    expect(started?.turnId).toBeString()
    expect(started?.turnId).not.toBe(live.turnId)
    expect(started?.turnId).toBe(store.snapshot('busy-named')!.turnId)
    expect(started?.queuedSince).toBeUndefined()
    // An unknown name is a loss, which is what the follower fails the call on.
    expect(gate.callState('busy-named', 'run-unknown')).toBeNull()
  })

  test('a Stop while queued cancels the call instead of running it', async () => {
    store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const turns = createBufferedTurns({ store, gate })
    const live = store.create('busy-stop')

    let ran = false
    const pending = turns.runPipelineCall(
      async (call) => {
        ran = true
        return { reply: 'should not run', sessionId: call.sessionId! }
      },
      { message: 'go', sessionId: 'busy-stop' },
    )

    await new Promise((r) => setTimeout(r, 30))
    gate.markStopped('busy-stop')

    await expect(pending).rejects.toThrow('stopped')
    expect(ran).toBe(false)
    expect(gate.queued('busy-stop')).toBeNull()
    live.complete()
  })

  test('onTurnStarted fires only once a buffer exists', async () => {
    store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const turns = createBufferedTurns({ store, gate })
    const live = store.create('busy-chat')

    let started = false
    const pending = turns.runPipelineCall(
      async (call) => ({ reply: 'done', sessionId: call.sessionId! }),
      { message: 'go', sessionId: 'busy-chat' },
      { onTurnStarted: () => { started = true } },
    )

    await new Promise((r) => setTimeout(r, 60))
    expect(started).toBe(false)

    live.complete()
    await pending
    expect(started).toBe(true)
  })
})

describe('isOpenableChatSession', () => {
  test('only real chat ids are openable', () => {
    expect(isOpenableChatSession('8a1c7e2e-0000-5000-8000-000000000000')).toBe(true)
    expect(isOpenableChatSession('run:abc')).toBe(false)
    expect(isOpenableChatSession('pipeline')).toBe(false)
    expect(isOpenableChatSession(undefined)).toBe(false)
  })
})

/**
 * The seq heartbeat is what the journal used to write a row for every 250 ms
 * (SHO-319). It now writes only when the seq moved, plus a keepalive.
 */
describe('seq heartbeat (SHO-319)', () => {
  const withFakeTimers = (fn: () => void) => {
    jest.useFakeTimers()
    try {
      fn()
    } finally {
      jest.useRealTimers()
    }
  }

  test('an idle turn writes at most two frames in 10 s', () => {
    withFakeTimers(() => {
      const sent: number[] = []
      const stop = startSeqHeartbeat({ getSeq: () => 5, write: (seq) => sent.push(seq) })

      jest.advanceTimersByTime(10_000)
      stop()

      // One for the first observation, then one keepalive at 5 s. The old tick
      // wrote 40.
      expect(sent).toEqual([5, 5])
    })
  })

  test('a keepalive arrives every SEQ_KEEPALIVE_MS while the seq is still', () => {
    withFakeTimers(() => {
      const sent: number[] = []
      const stop = startSeqHeartbeat({ getSeq: () => 3, write: (seq) => sent.push(seq) })

      jest.advanceTimersByTime(SEQ_HEARTBEAT_MS)
      expect(sent).toHaveLength(1)
      // The keepalive is measured from the last frame, not from the turn start.
      jest.advanceTimersByTime(SEQ_KEEPALIVE_MS - 1)
      expect(sent).toHaveLength(1)
      jest.advanceTimersByTime(1)
      expect(sent).toHaveLength(2)
      stop()
    })
  })

  test('each seq change produces exactly one frame within one tick', () => {
    withFakeTimers(() => {
      let seq = 1
      const sent: number[] = []
      const stop = startSeqHeartbeat({ getSeq: () => seq, write: (s) => sent.push(s) })

      jest.advanceTimersByTime(SEQ_HEARTBEAT_MS)
      expect(sent).toEqual([1])

      // Unchanged: no frame, and no keepalive yet.
      jest.advanceTimersByTime(SEQ_HEARTBEAT_MS)
      expect(sent).toEqual([1])

      seq = 2
      jest.advanceTimersByTime(SEQ_HEARTBEAT_MS)
      expect(sent).toEqual([1, 2])

      seq = 3
      jest.advanceTimersByTime(SEQ_HEARTBEAT_MS)
      expect(sent).toEqual([1, 2, 3])

      stop()
    })
  })

  test('nothing is written before the turn has a seq', () => {
    withFakeTimers(() => {
      const sent: number[] = []
      const stop = startSeqHeartbeat({ getSeq: () => 0, write: (seq) => sent.push(seq) })

      jest.advanceTimersByTime(10_000)
      stop()
      expect(sent).toEqual([])
    })
  })

  test('a write that throws stops the heartbeat instead of retrying forever', () => {
    withFakeTimers(() => {
      let calls = 0
      const stop = startSeqHeartbeat({
        getSeq: () => 1,
        write: () => {
          calls++
          throw new Error('client gone')
        },
      })

      jest.advanceTimersByTime(10_000)
      stop()
      expect(calls).toBe(1)
    })
  })

  test('the stop function ends the timer', () => {
    withFakeTimers(() => {
      const sent: number[] = []
      const stop = startSeqHeartbeat({ getSeq: () => 1, write: (seq) => sent.push(seq) })

      jest.advanceTimersByTime(SEQ_HEARTBEAT_MS)
      stop()
      jest.advanceTimersByTime(10_000)
      expect(sent).toHaveLength(1)
    })
  })
})
