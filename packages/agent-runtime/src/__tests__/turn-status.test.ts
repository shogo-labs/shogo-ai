// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /agent/chat/:id/turn` is how a caller whose stream follower missed a
 * finished `project_call` turn still learns what the callee said. The reply has
 * to outlive the turn's stream buffer (30 s grace) but not leak into a newer
 * turn on the same session.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import { describeTurn } from '../turn-status'

const enc = new TextEncoder()

let store: StreamBufferStore
afterEach(() => {
  setSystemTime()
  store?.dispose()
})

describe('describeTurn', () => {
  test('an unknown session is a 404 with no reply', () => {
    store = new StreamBufferStore()
    expect(describeTurn(store, 'sess-1')).toEqual({ status: 404, body: { status: 'unknown' } })
  })

  test('an active turn reports no reply, a completed one reports its final text', () => {
    store = new StreamBufferStore()
    const writer = store.create('sess-1')
    writer.append(enc.encode('data: {"type":"text-delta"}\n\n'))

    const active = describeTurn(store, 'sess-1')
    expect(active.status).toBe(200)
    expect(active.body).toMatchObject({ status: 'active', reply: null })

    writer.complete()
    store.recordTurnReply('sess-1', 'the final answer')

    const completed = describeTurn(store, 'sess-1')
    expect(completed.status).toBe(200)
    expect(completed.body).toMatchObject({ status: 'completed', reply: 'the final answer' })
  })

  test('the reply is still readable after the buffer is evicted, then expires', () => {
    store = new StreamBufferStore()
    store.create('sess-1').complete()
    store.recordTurnReply('sess-1', 'kept for an hour')
    const bufferTurnId = store.snapshot('sess-1')!.turnId

    // 31 s later the completed buffer is past its 30 s grace and is dropped.
    setSystemTime(new Date(Date.now() + 31_000))
    store.cleanup()
    expect(store.snapshot('sess-1')).toBeNull()

    const afterEviction = describeTurn(store, 'sess-1')
    expect(afterEviction.status).toBe(200)
    expect(afterEviction.body).toMatchObject({
      turnId: bufferTurnId,
      status: 'completed',
      reply: 'kept for an hour',
    })

    setSystemTime(new Date(Date.now() + 61 * 60_000))
    expect(describeTurn(store, 'sess-1')).toEqual({ status: 404, body: { status: 'unknown' } })
  })

  test("a newer turn on the session never reports the previous turn's reply", () => {
    store = new StreamBufferStore()
    store.create('sess-1').complete()
    store.recordTurnReply('sess-1', 'first turn')

    store.create('sess-1')
    expect(describeTurn(store, 'sess-1').body.reply).toBeNull()
  })

  test('a blank reply is not recorded', () => {
    store = new StreamBufferStore()
    store.create('sess-1').complete()
    store.recordTurnReply('sess-1', '   ')
    expect(store.turnReply('sess-1')).toBeNull()
    expect(describeTurn(store, 'sess-1').body.reply).toBeNull()
  })
})
