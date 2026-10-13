// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai'
import { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import { buildSnapshotReplay, MESSAGE_SNAPSHOT_EVENT_TYPE } from '../stream-snapshot'

const enc = new TextEncoder()
const dec = new TextDecoder()
const frame = (chunk: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(chunk)}\n\n`)

/** Two steps; the second is still open (text part reusing id "0", streaming tool input). */
function turn(deltas: number): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [
    { type: 'start', messageId: 'm1' },
    { type: 'data-turn-start', data: { turnId: 't' } },
    { type: 'data-context-usage', data: { inputTokens: 1 }, transient: true },
    { type: 'start-step' },
    { type: 'reasoning-start', id: 'r0' },
  ]
  for (let i = 0; i < deltas; i++) chunks.push({ type: 'reasoning-delta', id: 'r0', delta: `think ${i} ` })
  chunks.push(
    { type: 'reasoning-end', id: 'r0' },
    { type: 'tool-input-start', toolCallId: 'c1', toolName: 'exec' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'exec', input: { command: 'ls' } },
    { type: 'data-context-usage', data: { inputTokens: 2 }, transient: true },
    { type: 'text-start', id: '0' },
  )
  for (let i = 0; i < deltas; i++) chunks.push({ type: 'text-delta', id: '0', delta: `a${i} ` })
  chunks.push(
    { type: 'text-end', id: '0' },
    { type: 'finish-step' },
    { type: 'start-step' },
    // c1's output lands in the next step: the snapshot must leave the part
    // open for it.
    { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
    { type: 'tool-input-start', toolCallId: 'c2', toolName: 'exec' },
    { type: 'tool-input-delta', toolCallId: 'c2', inputTextDelta: '{"comm' },
    { type: 'text-start', id: '0' },
  )
  for (let i = 0; i < deltas; i++) chunks.push({ type: 'text-delta', id: '0', delta: `b${i} ` })
  return chunks
}

const toStream = (frames: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f)
      controller.close()
    },
  })

function parseChunks(bytes: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  return parseJsonEventStream({ stream: bytes, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream({
      transform(result, controller) {
        if (!result.success) throw result.error
        controller.enqueue(result.value as UIMessageChunk)
      },
    }),
  )
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Record<string, any>[]> {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  return text.split('\n\n').filter((e) => e.startsWith('data: {')).map((e) => JSON.parse(e.slice(6)))
}

async function finalMessage(chunks: ReadableStream<UIMessageChunk>, message?: UIMessage) {
  let last = message
  for await (const m of readUIMessageStream({ stream: chunks, message })) last = m
  return last
}

/** What the client does: apply the snapshot, then feed the rest to the SDK seeded with it. */
async function joinLikeClient(events: Record<string, any>[]) {
  const snapshotEvent = events.find((e) => e.type === MESSAGE_SNAPSHOT_EVENT_TYPE)
  const rest = events.filter((e) => e !== snapshotEvent)
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const e of rest) controller.enqueue(e as UIMessageChunk)
      controller.close()
    },
  })
  return finalMessage(stream, snapshotEvent?.data.message)
}

describe('buildSnapshotReplay', () => {
  test('snapshot + rest rebuilds the same message as the raw replay', async () => {
    const frames = turn(300).map(frame)
    const bytes = await buildSnapshotReplay(frames)
    const events = (await readAll(toStream([bytes])))

    expect(events[0]!.type).toBe(MESSAGE_SNAPSHOT_EVENT_TYPE)
    const expected = await finalMessage(parseChunks(toStream(frames)))
    expect(await joinLikeClient(events)).toEqual(expected)
  })

  test('sends only the unfinished step as chunks, never the finished steps', async () => {
    const events = await readAll(toStream([await buildSnapshotReplay(turn(300).map(frame))]))
    const types = events.map((e) => e.type)
    expect(types).not.toContain('reasoning-start')
    expect(types).not.toContain('start')
    expect(types.slice(0, 3)).toEqual([MESSAGE_SNAPSHOT_EVENT_TYPE, 'data-context-usage', 'start-step'])
    expect(events.length).toBeLessThan(12)
    // Latest transient state only.
    expect(events.filter((e) => e.type === 'data-context-usage')).toHaveLength(1)
    expect(events.find((e) => e.type === 'data-context-usage')!.data.inputTokens).toBe(2)
  })

  test('snapshot message holds the finished work (parts, tool call, reasoning)', async () => {
    const [snapshot] = await readAll(toStream([await buildSnapshotReplay(turn(5).map(frame))]))
    const parts = snapshot!.data.message.parts as Array<Record<string, any>>
    expect(snapshot!.data.message.id).toBe('m1')
    expect(parts.some((p) => p.type === 'reasoning' && p.text.includes('think 4'))).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text.includes('a4'))).toBe(true)
    expect(parts.some((p) => p.type === 'tool-exec' && p.toolCallId === 'c1')).toBe(true)
  })

  test('falls back to the compacted replay before the first step finishes', async () => {
    const frames = turn(20).slice(0, 12).map(frame)
    const events = await readAll(toStream([await buildSnapshotReplay(frames)]))
    expect(events.map((e) => e.type)).not.toContain(MESSAGE_SNAPSHOT_EVENT_TYPE)
    expect(events[0]!.type).toBe('start')
  })
})

describe('StreamBufferStore buildReplay', () => {
  test('snapshot, exact seq, then live frames that finish the same message', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    const all = turn(100)
    for (const c of all) writer.append(frame(c))
    const lastSeq = writer.lastSeq

    const reader = store.createReplayStream('s', { buildReplay: buildSnapshotReplay })!.getReader()
    const first = await reader.read()
    const seq = await reader.read()
    expect(dec.decode(first.value!)).toContain(MESSAGE_SNAPSHOT_EVENT_TYPE)
    expect(JSON.parse(dec.decode(seq.value!).slice(6))).toEqual({
      type: 'data-turn-seq',
      data: { turnId: 't', seq: lastSeq },
      transient: true,
    })

    writer.append(frame({ type: 'text-delta', id: '0', delta: 'live' }))
    expect(dec.decode((await reader.read()).value!)).toContain('"delta":"live"')
    reader.cancel()
    store.dispose()
  })

  test('frames written while an async builder runs arrive after its output, in order', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    writer.append(frame({ type: 'text-start', id: '0' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'old' }))

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stream = store.createReplayStream('s', {
      buildReplay: async () => {
        await gate
        return enc.encode('data: {"type":"data-built","data":1}\n\n')
      },
    })!
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'during-1' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'during-2' }))
    release()

    const reader = stream.getReader()
    const out: string[] = []
    for (let i = 0; i < 4; i++) out.push(dec.decode((await reader.read()).value!))
    expect(out[0]).toContain('data-built')
    expect(out[1]).toContain('data-turn-seq')
    expect(out[2]).toContain('during-1')
    expect(out[3]).toContain('during-2')

    writer.append(frame({ type: 'text-delta', id: '0', delta: 'after' }))
    expect(dec.decode((await reader.read()).value!)).toContain('after')
    reader.cancel()
    store.dispose()
  })

  test('closes after the held frames when the turn completes during the build', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    writer.append(frame({ type: 'text-start', id: '0' }))
    const stream = store.createReplayStream('s', {
      buildReplay: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return enc.encode('data: {"type":"data-built","data":1}\n\n')
      },
    })!
    writer.append(frame({ type: 'text-end', id: '0' }))
    writer.complete()
    const events = await readAll(stream)
    expect(events.map((e) => e.type)).toEqual(['data-built', 'data-turn-seq', 'text-end'])
    store.dispose()
  })

  test('falls back to the compacted replay when the builder throws', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    writer.append(frame({ type: 'text-start', id: '0' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'a' }))
    writer.append(frame({ type: 'text-delta', id: '0', delta: 'b' }))
    writer.complete()
    const events = await readAll(
      store.createReplayStream('s', { buildReplay: () => { throw new Error('boom') } })!,
    )
    expect(events).toEqual([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'ab' },
    ])
    store.dispose()
  })

  test('cancelling during the build unsubscribes', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    writer.append(frame({ type: 'text-start', id: '0' }))
    const stream = store.createReplayStream('s', {
      buildReplay: () => new Promise<Uint8Array>(() => {}),
    })!
    await stream.cancel()
    expect(() => writer.append(frame({ type: 'text-delta', id: '0', delta: 'x' }))).not.toThrow()
    store.dispose()
  })
})
