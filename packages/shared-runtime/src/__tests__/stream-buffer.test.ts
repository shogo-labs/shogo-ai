// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, afterEach } from 'bun:test'
import { StreamBufferStore, createBufferingTransform } from '../stream-buffer'

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

describe('StreamBufferStore', () => {
  let store: StreamBufferStore

  afterEach(() => {
    store?.dispose()
  })

  test('create + append + replay returns chunks in order', async () => {
    store = new StreamBufferStore()
    store.create('sess-1')
    store.append('sess-1', encode('chunk-1\n'))
    store.append('sess-1', encode('chunk-2\n'))
    store.complete('sess-1')

    const replay = store.createReplayStream('sess-1')
    expect(replay).not.toBeNull()
    const text = await collectStream(replay!)
    expect(text).toBe('chunk-1\nchunk-2\n')
  })

  test('createReplayStream returns null for unknown key', () => {
    store = new StreamBufferStore()
    expect(store.createReplayStream('nonexistent')).toBeNull()
  })

  test('has() reports correctly', () => {
    store = new StreamBufferStore()
    expect(store.has('key')).toBe(false)
    store.create('key')
    expect(store.has('key')).toBe(true)
  })

  test('live subscriber receives chunks appended after subscription', async () => {
    store = new StreamBufferStore()
    store.create('live')

    const replay = store.createReplayStream('live')!
    const reader = replay.getReader()

    store.append('live', encode('first\n'))
    const { value: v1, done: d1 } = await reader.read()
    expect(d1).toBe(false)
    expect(new TextDecoder().decode(v1)).toBe('first\n')

    store.append('live', encode('second\n'))
    const { value: v2, done: d2 } = await reader.read()
    expect(d2).toBe(false)
    expect(new TextDecoder().decode(v2)).toBe('second\n')

    store.complete('live')
    const { done: d3 } = await reader.read()
    expect(d3).toBe(true)
  })

  test('replay + live: existing chunks come first, then live', async () => {
    store = new StreamBufferStore()
    store.create('hybrid')
    store.append('hybrid', encode('buffered-1\n'))
    store.append('hybrid', encode('buffered-2\n'))

    const replay = store.createReplayStream('hybrid')!
    const reader = replay.getReader()

    // Should get buffered chunks immediately
    const { value: b1 } = await reader.read()
    expect(new TextDecoder().decode(b1)).toBe('buffered-1\n')
    const { value: b2 } = await reader.read()
    expect(new TextDecoder().decode(b2)).toBe('buffered-2\n')

    // Now append live
    store.append('hybrid', encode('live-1\n'))
    const { value: l1 } = await reader.read()
    expect(new TextDecoder().decode(l1)).toBe('live-1\n')

    store.complete('hybrid')
    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  test('complete() closes all subscribers', async () => {
    store = new StreamBufferStore()
    store.create('closing')

    const replay = store.createReplayStream('closing')!
    const reader = replay.getReader()

    store.append('closing', encode('data\n'))
    await reader.read()

    store.complete('closing')
    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  test('replay of completed stream returns all data then closes', async () => {
    store = new StreamBufferStore()
    store.create('done')
    store.append('done', encode('a'))
    store.append('done', encode('b'))
    store.complete('done')

    const replay = store.createReplayStream('done')!
    const text = await collectStream(replay)
    expect(text).toBe('ab')
  })

  test('isolation: two buffers do not cross-contaminate', async () => {
    store = new StreamBufferStore()
    store.create('a')
    store.create('b')

    store.append('a', encode('for-a'))
    store.append('b', encode('for-b'))
    store.complete('a')
    store.complete('b')

    const textA = await collectStream(store.createReplayStream('a')!)
    const textB = await collectStream(store.createReplayStream('b')!)
    expect(textA).toBe('for-a')
    expect(textB).toBe('for-b')
  })

  test('concurrent subscribers each get full replay', async () => {
    store = new StreamBufferStore()
    store.create('shared')
    store.append('shared', encode('x'))
    store.append('shared', encode('y'))
    store.complete('shared')

    const s1 = store.createReplayStream('shared')!
    const s2 = store.createReplayStream('shared')!

    const [t1, t2] = await Promise.all([collectStream(s1), collectStream(s2)])
    expect(t1).toBe('xy')
    expect(t2).toBe('xy')
  })

  test('create() replaces existing active buffer', async () => {
    store = new StreamBufferStore()
    store.create('replace')
    store.append('replace', encode('old'))

    // Replace — old buffer should be completed
    store.create('replace')
    store.append('replace', encode('new'))
    store.complete('replace')

    const text = await collectStream(store.createReplayStream('replace')!)
    expect(text).toBe('new')
  })

  test('append on unknown key is a no-op', () => {
    store = new StreamBufferStore()
    // Should not throw
    store.append('nope', encode('data'))
  })

  test('complete on unknown key is a no-op', () => {
    store = new StreamBufferStore()
    store.complete('nope')
  })

  test('cleanup removes old buffers', () => {
    store = new StreamBufferStore()
    store.create('stale')
    store.complete('stale')

    // Manually age the buffer
    const buf = (store as any).buffers.get('stale')
    buf.completedAt = Date.now() - 60_000

    store.cleanup()
    expect(store.has('stale')).toBe(false)
  })

  test('bound writer becomes no-op when buffer is replaced', async () => {
    store = new StreamBufferStore()
    const oldWriter = store.create('key')
    oldWriter.append(encode('old-data'))

    // Replace the buffer — old writer should become inert
    const newWriter = store.create('key')
    newWriter.append(encode('new-data'))

    // Old writer appends should be no-ops (old buffer was completed)
    oldWriter.append(encode('STALE'))

    newWriter.complete()
    const text = await collectStream(store.createReplayStream('key')!)
    expect(text).toBe('new-data')
  })

  test('bound writer complete does not affect replacement buffer', async () => {
    store = new StreamBufferStore()
    const oldWriter = store.create('key')
    oldWriter.append(encode('old'))

    const newWriter = store.create('key')
    newWriter.append(encode('new'))

    // Completing the old writer should NOT close the new buffer
    oldWriter.complete()

    // New buffer should still be active and appendable
    newWriter.append(encode('-more'))
    newWriter.complete()

    const text = await collectStream(store.createReplayStream('key')!)
    expect(text).toBe('new-more')
  })

  test('abort removes buffer so resume returns null', async () => {
    store = new StreamBufferStore()
    const writer = store.create('sess')
    writer.append(encode('chunk-1'))
    writer.append(encode('chunk-2'))

    store.abort('sess')

    expect(store.has('sess')).toBe(false)
    expect(store.createReplayStream('sess')).toBeNull()

    // Bound writer becomes a safe no-op (buf object completed via closure)
    writer.append(encode('STALE'))
    writer.complete()
    expect(store.has('sess')).toBe(false)
  })

  test('abort closes active subscribers before removing buffer', async () => {
    store = new StreamBufferStore()
    const writer = store.create('sess')
    writer.append(encode('data'))

    const replay = store.createReplayStream('sess')!
    const reader = replay.getReader()

    const { value: first } = await reader.read()
    expect(new TextDecoder().decode(first!)).toBe('data')

    store.abort('sess')

    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  test('dispose clears everything', () => {
    store = new StreamBufferStore()
    store.create('a')
    store.create('b')
    store.dispose()

    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(false)
  })
})

describe('createBufferingTransform', () => {
  test('passes chunks through and buffers them', async () => {
    const store = new StreamBufferStore()
    store.create('transform-test')

    const transform = createBufferingTransform(store, 'transform-test')
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('line-1\n'))
        controller.enqueue(encode('line-2\n'))
        controller.close()
      },
    })

    // Read through the transform
    const output = await collectStream(source.pipeThrough(transform))
    expect(output).toBe('line-1\nline-2\n')

    // Buffer should also have the data (and be completed via flush)
    const replay = store.createReplayStream('transform-test')!
    const replayed = await collectStream(replay)
    expect(replayed).toBe('line-1\nline-2\n')

    store.dispose()
  })

  test('flush marks buffer complete', async () => {
    const store = new StreamBufferStore()
    store.create('flush-test')

    const transform = createBufferingTransform(store, 'flush-test')
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('data'))
        controller.close()
      },
    })

    await collectStream(source.pipeThrough(transform))

    // After flush, replay should return completed stream
    const replay = store.createReplayStream('flush-test')!
    const text = await collectStream(replay)
    expect(text).toBe('data')

    store.dispose()
  })
})
