// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai'
import { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import { buildSnapshotReplay, MESSAGE_SNAPSHOT_EVENT_TYPE } from '../stream-snapshot'

const enc = new TextEncoder()
const dec = new TextDecoder()
const frame = (chunk: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(chunk)}\n\n`)

const deltas = (type: 'text-delta' | 'reasoning-delta', id: string, count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => ({ type, id, delta: `${prefix}${i} ` }))

/** One sub-agent update, as `emitPreliminary` writes it: the whole accumulated state. */
const spawnUpdate = (i: number, text = `update ${i} `) => ({
  type: 'tool-output-available',
  toolCallId: 'spawn',
  output: { agentId: 'a1', instance_id: 'i1', model: 'm', parts: [{ type: 'text', text, id: 'sa-text-0' }] },
  dynamic: true,
  preliminary: true,
})

/**
 * A turn shaped like the runtime's: `buffered-turn.ts` writes one `start-step`
 * when the turn begins and one `finish-step` when it ends, so nothing closes a
 * step mid-turn. Reasoning, a tool call and the answer's text close, then
 * `agent_spawn` runs a sub-agent that streams `updates` preliminary outputs and
 * is still going when the client joins.
 */
function liveTurn(updates: number): Record<string, unknown>[] {
  return [
    { type: 'start', messageId: 'm1' },
    { type: 'data-turn-start', data: { turnId: 't' } },
    { type: 'data-context-usage', data: { inputTokens: 1 }, transient: true },
    { type: 'start-step' },
    { type: 'reasoning-start', id: 'r0' },
    ...deltas('reasoning-delta', 'r0', 3, 'think'),
    { type: 'reasoning-end', id: 'r0' },
    { type: 'tool-input-start', toolCallId: 'c1', toolName: 'exec' },
    { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"command":' },
    { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '"ls"}' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'exec', input: { command: 'ls' } },
    { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
    { type: 'text-start', id: '0' },
    ...deltas('text-delta', '0', 3, 'answer'),
    { type: 'text-end', id: '0' },
    { type: 'data-context-usage', data: { inputTokens: 2 }, transient: true },
    { type: 'tool-input-start', toolCallId: 'spawn', toolName: 'agent_spawn' },
    { type: 'tool-input-available', toolCallId: 'spawn', toolName: 'agent_spawn', input: { type: 'browser_qa' } },
    ...Array.from({ length: updates }, (_, i) => spawnUpdate(i)),
  ]
}

/** The closed work of `liveTurn`, as a prefix the mid-part cases build on. */
const closedWork = () => liveTurn(0).slice(0, 14)

/** Joined while the answer's text is still streaming. */
const midTextDelta = () => [...closedWork(), { type: 'text-start', id: '0' }, ...deltas('text-delta', '0', 3, 'half')]

/** Joined while a tool call's input is still streaming. */
const midToolInput = () => [
  ...closedWork(),
  { type: 'tool-input-start', toolCallId: 'spawn', toolName: 'agent_spawn' },
  { type: 'tool-input-delta', toolCallId: 'spawn', inputTextDelta: '{"type":' },
]

/** A turn that has finished: every part closed, `finish-step` and `finish` written. */
const finishedTurn = () => [
  ...closedWork(),
  { type: 'text-start', id: '0' },
  ...deltas('text-delta', '0', 3, 'answer'),
  { type: 'text-end', id: '0' },
  { type: 'finish-step' },
  { type: 'finish' },
]

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

const snapshotOf = (events: Record<string, any>[]) => events.find((e) => e.type === MESSAGE_SNAPSHOT_EVENT_TYPE)
const continuationOf = (events: Record<string, any>[]) => events.filter((e) => e.type !== MESSAGE_SNAPSHOT_EVENT_TYPE)

/** The continuation's part chunks, without the re-sent transient state. */
const partChunks = (events: Record<string, any>[]) => continuationOf(events).filter((e) => !e.type.startsWith('data-'))

/** What the client does: apply the snapshot, then feed the rest to the SDK seeded with it. */
async function joinLikeClient(events: Record<string, any>[]) {
  const rest = continuationOf(events)
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const e of rest) controller.enqueue(e as UIMessageChunk)
      controller.close()
    },
  })
  return finalMessage(stream, snapshotOf(events)?.data.message)
}

/** The same message built the old way, chunk by chunk, from the raw buffered frames. */
const fullReplayMessage = (chunks: Record<string, unknown>[]) =>
  finalMessage(parseChunks(toStream(chunks.map(frame))))

describe('buildSnapshotReplay', () => {
  test('a live turn gets a snapshot and one sub-agent update, whatever N is', async () => {
    for (const updates of [1, 50, 200]) {
      const events = await readAll(toStream([await buildSnapshotReplay(liveTurn(updates).map(frame))]))

      expect(events[0]!.type).toBe(MESSAGE_SNAPSHOT_EVENT_TYPE)
      const parts = snapshotOf(events)!.data.message.parts as Array<Record<string, any>>
      expect(parts.some((p) => p.type === 'text' && p.text.includes('answer'))).toBe(true)
      // The sub-agent's update history collapses to its current state.
      expect(continuationOf(events).filter((e) => e.preliminary === true)).toHaveLength(1)
      expect(events.at(-1)!.output.parts[0].text).toContain(`update ${updates - 1}`)
      expect(events.map((e) => e.type)).toEqual([
        MESSAGE_SNAPSHOT_EVENT_TYPE,
        'data-context-usage',
        'tool-input-start',
        'tool-input-available',
        'tool-output-available',
      ])
    }
  })

  test('snapshot + continuation rebuilds the same message as the raw replay', async () => {
    const chunks = liveTurn(50)
    const events = await readAll(toStream([await buildSnapshotReplay(chunks.map(frame))]))
    expect(await joinLikeClient(events)).toEqual(await fullReplayMessage(chunks))
  })

  test('joining mid text delta cuts at the last closed part', async () => {
    const chunks = midTextDelta()
    const events = await readAll(toStream([await buildSnapshotReplay(chunks.map(frame))]))

    expect(events[0]!.type).toBe(MESSAGE_SNAPSHOT_EVENT_TYPE)
    expect(partChunks(events)[0]!.type).toBe('text-start')
    expect(await joinLikeClient(events)).toEqual(await fullReplayMessage(chunks))
  })

  test('joining mid tool input cuts at the last closed part', async () => {
    const chunks = midToolInput()
    const events = await readAll(toStream([await buildSnapshotReplay(chunks.map(frame))]))

    expect(events[0]!.type).toBe(MESSAGE_SNAPSHOT_EVENT_TYPE)
    expect(partChunks(events).map((e) => e.type)).toEqual(['tool-input-start', 'tool-input-delta'])
    expect(await joinLikeClient(events)).toEqual(await fullReplayMessage(chunks))
  })

  test('sends only the unfinished part as chunks, never the finished work', async () => {
    const events = await readAll(toStream([await buildSnapshotReplay(liveTurn(50).map(frame))]))
    const types = events.map((e) => e.type)
    expect(types).not.toContain('reasoning-start')
    expect(types).not.toContain('start')
    // Latest transient state only.
    expect(events.filter((e) => e.type === 'data-context-usage')).toHaveLength(1)
    expect(events.find((e) => e.type === 'data-context-usage')!.data.inputTokens).toBe(2)
  })

  test('snapshot message holds the finished work (parts, tool call, reasoning)', async () => {
    const events = await readAll(toStream([await buildSnapshotReplay(liveTurn(50).map(frame))]))
    const parts = snapshotOf(events)!.data.message.parts as Array<Record<string, any>>
    expect(snapshotOf(events)!.data.message.id).toBe('m1')
    expect(parts.some((p) => p.type === 'reasoning' && p.text.includes('think2'))).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text.includes('answer2'))).toBe(true)
    expect(parts.some((p) => p.type === 'tool-exec' && p.toolCallId === 'c1' && p.state === 'output-available')).toBe(true)
  })

  test('a finished turn snapshots the whole message and sends no continuation', async () => {
    const chunks = finishedTurn()
    const events = await readAll(toStream([await buildSnapshotReplay(chunks.map(frame))]))
    expect(events.map((e) => e.type)).toEqual([MESSAGE_SNAPSHOT_EVENT_TYPE, 'data-context-usage'])
    expect(await joinLikeClient(events)).toEqual(await fullReplayMessage(chunks))
  })

  test('falls back to the compacted replay until a part closes', async () => {
    const frames = [
      { type: 'start', messageId: 'm1' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r0' },
      ...deltas('reasoning-delta', 'r0', 20, 'think'),
    ].map(frame)
    const events = await readAll(toStream([await buildSnapshotReplay(frames)]))
    expect(events.map((e) => e.type)).not.toContain(MESSAGE_SNAPSHOT_EVENT_TYPE)
    expect(events[0]!.type).toBe('start')
  })
})

describe('StreamBufferStore buildReplay', () => {
  test('snapshot, exact seq, then live frames that finish the same message', async () => {
    const store = new StreamBufferStore()
    const writer = store.create('s', { turnId: 't' })
    for (const c of liveTurn(100)) writer.append(frame(c))
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

    writer.append(frame(spawnUpdate(100, 'live')))
    expect(dec.decode((await reader.read()).value!)).toContain('"text":"live"')
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
