import { describe, expect, test } from 'bun:test'
import { MAX_CONTEXT_TEXT_LENGTH, MAX_PENDING_BATCHES, PENDING_BATCH_TTL_MS, ShogoContextOutbox, truncateText } from '../contextOutbox'

const file = (path: string) => ({ type: 'file' as const, path, name: path })

describe('ShogoContextOutbox', () => {
  test('enqueue / pending / ack / clear', () => {
    const outbox = new ShogoContextOutbox()
    const a = outbox.enqueue([file('a.ts')])
    const b = outbox.enqueue([file('b.ts')])
    expect(a).not.toBe(b)
    expect(outbox.pending().map((p) => p.batchId)).toEqual([a, b])
    expect(outbox.ack(a)).toBe(true)
    expect(outbox.ack(a)).toBe(false)
    expect(outbox.pending().map((p) => p.references[0].path)).toEqual(['b.ts'])
    outbox.clear()
    expect(outbox.pending()).toEqual([])
  })

  test('unacknowledged batches are re-sent after a reconnect, unchanged', () => {
    const outbox = new ShogoContextOutbox()
    const id = outbox.enqueue([file('a.ts')])
    const firstSend = outbox.pending()
    // The chat iframe reloaded before acknowledging: the next ready re-sends.
    const secondSend = outbox.pending()
    expect(secondSend).toEqual(firstSend)
    outbox.ack(id)
    expect(outbox.pending()).toEqual([])
  })

  test(`keeps at most ${MAX_PENDING_BATCHES} batches, dropping the oldest`, () => {
    const outbox = new ShogoContextOutbox()
    const ids = Array.from({ length: MAX_PENDING_BATCHES + 3 }, (_, i) => outbox.enqueue([file(`${i}.ts`)]))
    expect(outbox.pending().map((p) => p.batchId)).toEqual(ids.slice(3))
  })

  test('batches the chat never acknowledges expire', () => {
    let now = 1_000_000
    const outbox = new ShogoContextOutbox(() => now)
    outbox.enqueue([file('old.ts')])
    now += PENDING_BATCH_TTL_MS - 1
    const fresh = outbox.enqueue([file('fresh.ts')])
    expect(outbox.pending()).toHaveLength(2)
    now += 2
    expect(outbox.pending().map((p) => p.batchId)).toEqual([fresh])
  })

  test('pending() returns copies', () => {
    const outbox = new ShogoContextOutbox()
    outbox.enqueue([file('a.ts')])
    outbox.pending()[0].references.push(file('x.ts'))
    expect(outbox.pending()[0].references).toHaveLength(1)
  })
})

describe('truncateText', () => {
  test('caps at the composer selection limit and reports it', () => {
    expect(truncateText('abc')).toEqual({ text: 'abc', truncated: false })
    const r = truncateText('x'.repeat(MAX_CONTEXT_TEXT_LENGTH + 1))
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(24_000)
  })
})
