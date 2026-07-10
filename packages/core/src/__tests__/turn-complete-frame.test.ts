// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REGRESSION (server side of the "messages never finish" wedge): guarantee a
 * terminal `data-turn-complete` frame lands in the durable buffer even when a
 * turn ends abnormally (bg-reader transport error / abort race) before the
 * normal terminal frame is written.
 *
 * The client's auto-resuming fetch keeps reconnecting to `/stream?fromSeq=N`
 * until it parses a `data-turn-complete` frame. A buffer that reaches a
 * terminal `status` WITHOUT one makes the client replay forever and pins the
 * composer in `streaming` (Stop/Queue). Mirrors `server.ts`'s bg-reader
 * `finally`: synthesize + append the terminal frame WHILE the buffer is still
 * `active` (so it gets a seq and reaches replays), then `complete()`.
 */
import { describe, test, expect } from 'bun:test'
import {
  StreamBufferStore,
  encodeTurnCompleteFrame,
  TURN_COMPLETE_EVENT_TYPE,
} from '../stream-buffer'

async function drainToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value, { stream: true })
  }
  return out
}

describe('encodeTurnCompleteFrame', () => {
  test('emits a parseable AI-SDK SSE data-part frame the client recognizes', () => {
    const bytes = encodeTurnCompleteFrame({
      turnId: 't1',
      chatSessionId: 's1',
      status: 'failed',
      error: 'boom',
      lastSeq: 4,
    })
    const text = new TextDecoder().decode(bytes)
    expect(text.startsWith('data: ')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(true)
    const evt = JSON.parse(text.slice('data: '.length).trim())
    expect(evt.type).toBe(TURN_COMPLETE_EVENT_TYPE)
    expect(evt.data.status).toBe('failed')
    expect(evt.data.lastSeq).toBe(4)
  })
})

describe('abnormal termination synthesizes a terminal frame', () => {
  test('a turn completed without a terminal frame gets one appended, so replays carry it', async () => {
    const store = new StreamBufferStore()
    const key = 'sess-abnormal'
    const writer = store.create(key)

    // Normal content lands, but the turn is torn (bg-reader error) before the
    // terminal frame is written — `terminalFrameWritten` stays false.
    writer.append(new TextEncoder().encode('data: {"type":"data-turn-start","data":{}}\n\n'))
    writer.append(new TextEncoder().encode('data: {"type":"text-delta","delta":"answer"}\n\n'))
    let terminalFrameWritten = false

    // ── server.ts bg-reader `finally` ─────────────────────────────────────
    if (!terminalFrameWritten) {
      writer.append(
        encodeTurnCompleteFrame({
          turnId: writer.turnId,
          chatSessionId: key,
          status: 'failed',
          error: 'stream ended without terminal frame',
          lastSeq: writer.lastSeq,
        }),
      )
      terminalFrameWritten = true
    }
    writer.complete()
    // ──────────────────────────────────────────────────────────────────────

    expect(terminalFrameWritten).toBe(true)

    // The buffer is now terminal. Both a full replay and a delta resume must
    // carry the terminal frame so the client stops reconnecting.
    const full = await drainToString(store.createReplayStream(key)!)
    expect(full).toContain('answer')
    expect(full).toContain(TURN_COMPLETE_EVENT_TYPE)

    // A resume from partway through still ends on the terminal frame.
    const delta = await drainToString(store.createReplayStream(key, { fromSeq: 1 })!)
    expect(delta).toContain(TURN_COMPLETE_EVENT_TYPE)

    store.dispose()
  })

  test('the synthesized terminal frame is assigned a seq (append ran while active)', async () => {
    const store = new StreamBufferStore()
    const key = 'sess-seq'
    const writer = store.create(key)
    writer.append(new TextEncoder().encode('data: {"type":"text-delta","delta":"x"}\n\n'))
    const seqBefore = writer.lastSeq

    const seq = (() => {
      // append returns the assigned seq (>0) only while the buffer is active.
      // This is why server.ts appends BEFORE calling complete().
      const w = writer
      w.append(
        encodeTurnCompleteFrame({ turnId: w.turnId, chatSessionId: key, status: 'failed', lastSeq: w.lastSeq }),
      )
      return w.lastSeq
    })()

    expect(seq).toBe(seqBefore + 1)
    writer.complete()
    store.dispose()
  })
})
