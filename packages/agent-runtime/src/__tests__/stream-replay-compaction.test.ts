// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage } from 'ai'
import { StreamBufferStore, compactSseFrames } from '@shogo-ai/sdk/stream-buffer'

const enc = new TextEncoder()
const frame = (chunk: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(chunk)}\n\n`)

/** A realistic long turn: reasoning, a streamed tool call, two steps of text reusing id "0". */
function longTurnFrames(deltas: number): Uint8Array[] {
  const frames: Uint8Array[] = []
  let seq = 0
  const push = (chunk: Record<string, unknown>) => {
    frames.push(frame(chunk))
    if (++seq % 20 === 0) frames.push(frame({ type: 'data-turn-seq', data: { turnId: 't', seq }, transient: true }))
  }
  push({ type: 'start', messageId: 'm1' })
  push({ type: 'data-turn-start', data: { turnId: 't', chatSessionId: 's' } })
  push({ type: 'start-step' })
  push({ type: 'reasoning-start', id: 'r0' })
  for (let i = 0; i < deltas; i++) push({ type: 'reasoning-delta', id: 'r0', delta: `think ${i} ` })
  push({ type: 'reasoning-end', id: 'r0', providerMetadata: { anthropic: { signature: 'sig' } } })
  push({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'exec' })
  const input = JSON.stringify({ command: 'echo '.repeat(50) })
  for (let i = 0; i < input.length; i += 3) push({ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: input.slice(i, i + 3) })
  push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'exec', input: JSON.parse(input) })
  push({ type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } })
  push({ type: 'text-start', id: '0' })
  for (let i = 0; i < deltas; i++) push({ type: 'text-delta', id: '0', delta: `a${i} ` })
  push({ type: 'text-end', id: '0' })
  push({ type: 'finish-step' })
  push({ type: 'start-step' })
  push({ type: 'tool-input-start', toolCallId: 'c2', toolName: 'exec' })
  push({ type: 'tool-input-delta', toolCallId: 'c2', inputTextDelta: '{"comm' })
  push({ type: 'text-start', id: '0' })
  for (let i = 0; i < deltas; i++) push({ type: 'text-delta', id: '0', delta: `b${i} ` })
  return frames
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(f)
      controller.close()
    },
  })
}

async function finalMessage(bytes: ReadableStream<Uint8Array>): Promise<UIMessage | undefined> {
  const chunks = parseJsonEventStream({ stream: bytes, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream({
      transform(result, controller) {
        if (!result.success) throw result.error
        controller.enqueue(result.value)
      },
    }),
  )
  let last: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream: chunks })) last = message
  return last
}

const countEvents = (bytes: Uint8Array) => new TextDecoder().decode(bytes).split('\n\n').filter(Boolean).length

describe('compactSseFrames', () => {
  test('rebuilds the same message as the raw replay with a handful of events', async () => {
    const frames = longTurnFrames(2000)
    const compacted = compactSseFrames(frames)

    expect(await finalMessage(streamOf([compacted]))).toEqual(await finalMessage(streamOf(frames)))
    expect(frames.length).toBeGreaterThan(6000)
    expect(countEvents(compacted)).toBeLessThan(25)
  })

  test('never merges deltas across a part restart that reuses the id', () => {
    const out = new TextDecoder().decode(compactSseFrames(longTurnFrames(3)))
    expect(out).toContain('"delta":"a0 a1 a2 "')
    expect(out).toContain('"delta":"b0 b1 b2 "')
  })

  test('keeps a streaming tool input but drops one that became available', () => {
    const out = new TextDecoder().decode(compactSseFrames(longTurnFrames(3)))
    expect(out).not.toContain('"toolCallId":"c1","inputTextDelta"')
    expect(out).toContain('{"type":"tool-input-delta","toolCallId":"c2","inputTextDelta":"{\\"comm"}')
  })

  test('drops heartbeats, keeps unparseable events and a trailing partial event verbatim', () => {
    const raw = enc.encode('data: [DONE]\n\n: keepalive\n\ndata: {"type":"text-del')
    const out = new TextDecoder().decode(
      compactSseFrames([frame({ type: 'data-turn-seq', data: { seq: 4 }, transient: true }), raw]),
    )
    expect(out).toBe('data: [DONE]\n\n: keepalive\n\ndata: {"type":"text-del')
  })

  test('handles an event split across frames', () => {
    const bytes = frame({ type: 'text-delta', id: '0', delta: 'héllo' })
    const out = compactSseFrames([bytes.slice(0, 20), bytes.slice(20)])
    expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(bytes))
  })
})

describe('StreamBufferStore compacted replay', () => {
  test('replays compacted, reports the exact seq, then streams live frames', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    for (const f of longTurnFrames(500)) writer.append(f)
    const lastSeq = writer.lastSeq

    const reader = store.createReplayStream('s', { compact: true })!.getReader()
    const first = await reader.read()
    const second = await reader.read()
    expect(countEvents(first.value!)).toBeLessThan(25)
    expect(JSON.parse(new TextDecoder().decode(second.value!).slice(6))).toEqual({
      type: 'data-turn-seq',
      data: { turnId: 't', seq: lastSeq },
      transient: true,
    })

    writer.append(frame({ type: 'text-delta', id: '0', delta: 'live' }))
    const live = await reader.read()
    expect(new TextDecoder().decode(live.value!)).toContain('"delta":"live"')
    reader.cancel()
    store.dispose()
  })

  test('a compacted replay from fromSeq leaves earlier frames out', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    writer.append(frame({ type: 'text-start', id: '0' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'seen ' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'new ' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'text' }))
    writer.complete()

    const reader = store.createReplayStream('s', { fromSeq: 2, compact: true })!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value!)).toBe('data: {"type":"text-delta","id":"0","delta":"new text"}\n\n')
    expect((await reader.read()).done).toBe(true)
    store.dispose()
  })
})
