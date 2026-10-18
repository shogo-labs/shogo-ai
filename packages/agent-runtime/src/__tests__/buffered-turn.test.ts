// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A project_call records the callee's turn as a chat, and "Open chat" on the
 * caller's card opens it. That chat can only stream if the pipeline turn runs
 * into the chat's stream buffer, like a chat turn does.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { StreamBufferStore } from '@shogo/shared-runtime'
import { LiveTurnGate } from '../live-turn-wait'
import { createBufferedTurns, isOpenableChatSession } from '../buffered-turn'

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

describe('isOpenableChatSession', () => {
  test('only real chat ids are openable', () => {
    expect(isOpenableChatSession('8a1c7e2e-0000-5000-8000-000000000000')).toBe(true)
    expect(isOpenableChatSession('run:abc')).toBe(false)
    expect(isOpenableChatSession('pipeline')).toBe(false)
    expect(isOpenableChatSession(undefined)).toBe(false)
  })
})
