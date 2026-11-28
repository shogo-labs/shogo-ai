// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The zero-loss invariant, at the relay: no chunk reaches the client before the
 * batch holding it is durable (SHO-274).
 *
 * These tests hold the journal insert open and assert that nothing was
 * forwarded; a database that is slow must delay the frame, never race it. A
 * journal that fails must not freeze the stream either — the frames go out and
 * the gap is logged by the journal itself.
 */
import { describe, expect, test } from 'bun:test'
import { createJournalledForwarder, isTransientOnlyChunk, JOURNAL_BATCH_WINDOW_MS } from '../journalled-forwarder'
import type { TurnJournalWriter } from '../../services/chat-turn-journal'

const chunk = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A complete `data-turn-seq` SSE event, as the runtime writes it. */
const seqFrame = (seq: number): string =>
  `data: ${JSON.stringify({ type: 'data-turn-seq', data: { turnId: 't1', seq }, transient: true })}\n\n`

/** A complete content event. */
const textFrame = (delta: string): string =>
  `data: ${JSON.stringify({ type: 'text-delta', id: 'x', delta })}\n\n`

interface HeldJournal {
  writer: TurnJournalWriter
  /** Resolve the insert currently in flight. */
  release: () => void
  batches: number
}

/**
 * A journal whose append never settles until the test releases it, so the test
 * can observe what the relay did while the write was in flight.
 */
function heldJournal(): HeldJournal {
  let release: () => void = () => {}
  let gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let batches = 0
  const writer = {
    append: async () => {
      batches++
      await gate
      // Re-arm for the next batch.
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return true
    },
    get written() {
      return batches
    },
  } as unknown as TurnJournalWriter
  return {
    writer,
    release: () => release(),
    get batches() {
      return batches
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Wait for the batch window to close, so the insert has actually started.
 * The window is what makes a token burst one row (SHO-319), so a test that
 * wants to observe an insert in flight has to let it elapse first.
 */
const windowElapsed = () => new Promise((resolve) => setTimeout(resolve, JOURNAL_BATCH_WINDOW_MS + 5))

/** A journal that records what it was asked to write, and resolves at once. */
function recordingJournal() {
  const appends: string[][] = []
  const writer = {
    append: async (frames: Array<Uint8Array | string>) => {
      appends.push(frames.map((f) => (typeof f === 'string' ? f : new TextDecoder().decode(f))))
      return true
    },
    get written() {
      return appends.length
    },
  } as unknown as TurnJournalWriter
  return { writer, appends }
}

describe('journalled forwarder (SHO-274)', () => {
  test('a held insert holds the client', async () => {
    const held = heldJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: held.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk('a'))
    forwarder.push(chunk('b'))
    await windowElapsed()

    expect(held.batches).toBe(1)
    expect(forwarded).toEqual([])

    held.release()
    await forwarder.drain()
    expect(forwarded).toEqual(['a', 'b'])
  })

  test('chunks that arrive during an insert go out as one batch, in order', async () => {
    const held = heldJournal()
    const forwarded: string[] = []
    const batches: number[] = []
    const forwarder = createJournalledForwarder({
      journal: held.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk('1'))
    await windowElapsed()
    batches.push(held.batches)
    // While the first insert is in flight the reader keeps reading.
    forwarder.push(chunk('2'))
    forwarder.push(chunk('3'))
    expect(forwarded).toEqual([])

    held.release()
    await settle()
    expect(forwarded).toEqual(['1'])
    expect(batches).toEqual([1])

    held.release()
    await forwarder.drain()
    expect(forwarded).toEqual(['1', '2', '3'])
    expect(held.batches).toBe(2)
  })

  test('the forwarder drains everything still held once the reader is done', async () => {
    const held = heldJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: held.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk('last'))
    // The relay awaits drain before closing the client stream; without this the
    // final frame of a turn would be dropped.
    const drained = forwarder.drain()
    held.release()
    await drained

    expect(forwarded).toEqual(['last'])
  })

  test('a turn with no journal now forwards immediately', async () => {
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: null,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk('x'))
    await forwarder.drain()
    expect(forwarded).toEqual(['x'])
  })

  test('a failed insert still releases the frames — the stream never freezes', async () => {
    const forwarded: string[] = []
    const writer = {
      append: async () => false,
      get written() {
        return 1
      },
    } as unknown as TurnJournalWriter
    const forwarder = createJournalledForwarder({
      journal: writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk('anyway'))
    await forwarder.drain()
    expect(forwarded).toEqual(['anyway'])
  })

  /**
   * #2293: the closing log line is the only place a turn says whether its
   * journal survived. It must say `dead@seqN` — the batch count alone reads as
   * a healthy journal that simply wrote fewer rows.
   */
  test('the closing status reports a dead journal instead of a healthy one', async () => {
    let failed = false
    const writer = {
      append: async () => {
        failed = true
        return false
      },
      get written() {
        return 1
      },
      get status() {
        return failed ? 'dead@seq0' : '1 batch(es)'
      },
    } as unknown as TurnJournalWriter
    const forwarder = createJournalledForwarder({ journal: writer, forward: () => {} })

    expect(forwarder.journalStatus).toBe('1 batch(es)')
    forwarder.push(chunk('a'))
    await forwarder.drain()
    expect(forwarder.journalStatus).toBe('dead@seq0')
  })

  test('a turn with no journal reports no journal status', () => {
    const forwarder = createJournalledForwarder({ journal: null, forward: () => {} })
    expect(forwarder.journalStatus).toBe('none')
  })
})

describe('seq heartbeats are forwarded but never journalled (SHO-319)', () => {
  test('a seq-only chunk reaches the client and is left out of the insert', async () => {
    const journal = recordingJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: journal.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk(seqFrame(7)))
    await forwarder.drain()

    expect(forwarded).toEqual([seqFrame(7)])
    expect(journal.appends).toEqual([])
  })

  test('a batch of nothing but seq chunks makes zero appends', async () => {
    const journal = recordingJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: journal.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    for (let seq = 1; seq <= 5; seq++) forwarder.push(chunk(seqFrame(seq)))
    await forwarder.drain()

    expect(journal.appends).toEqual([])
    expect(forwarded).toHaveLength(5)
  })

  test('order is preserved: a seq chunk is not forwarded before the content it follows is durable', async () => {
    const held = heldJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: held.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk(textFrame('A')))
    forwarder.push(chunk(seqFrame(1)))
    forwarder.push(chunk(textFrame('B')))
    await windowElapsed()

    // The insert is in flight: nothing at all has gone out, including the
    // heartbeat. Forwarding it early would let a reconnect resume at seq=1
    // before "A" is durable, and the person would lose it.
    expect(held.batches).toBe(1)
    expect(forwarded).toEqual([])

    held.release()
    await forwarder.drain()

    expect(forwarded).toEqual([textFrame('A'), seqFrame(1), textFrame('B')])
  })

  test('a chunk mixing a seq event with content is journalled byte-for-byte', async () => {
    const journal = recordingJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: journal.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    const mixed = seqFrame(3) + textFrame('hello')
    forwarder.push(chunk(mixed))
    await forwarder.drain()

    expect(journal.appends).toEqual([[mixed]])
    expect(forwarded).toEqual([mixed])
  })

  test('a chunk holding a partial SSE frame is journalled, not skipped', async () => {
    const journal = recordingJournal()
    const forwarder = createJournalledForwarder({ journal: journal.writer, forward: () => {} })

    // A seq event split across two chunks: neither half is a complete frame,
    // and the replay has to rebuild the bytes exactly as they were streamed.
    const whole = seqFrame(4)
    const head = whole.slice(0, 20)
    const tail = whole.slice(20)
    forwarder.push(chunk(head))
    forwarder.push(chunk(tail))
    await forwarder.drain()

    expect(journal.appends).toEqual([[head, tail]])
  })

  test('a chunk that merely contains the heartbeat string is journalled', async () => {
    const journal = recordingJournal()
    const forwarder = createJournalledForwarder({ journal: journal.writer, forward: () => {} })

    // Not a parseable event: the pre-filter must not be the whole test.
    const notAnEvent = 'data: {"type":"data-turn-seq"'
    forwarder.push(chunk(notAnEvent))
    await forwarder.drain()

    expect(journal.appends).toEqual([[notAnEvent]])
  })

  test('isTransientOnlyChunk only accepts complete, parseable seq events', () => {
    expect(isTransientOnlyChunk(chunk(seqFrame(1)))).toBe(true)
    expect(isTransientOnlyChunk(chunk(seqFrame(1) + seqFrame(2)))).toBe(true)
    expect(isTransientOnlyChunk(chunk(textFrame('x')))).toBe(false)
    expect(isTransientOnlyChunk(chunk(seqFrame(1) + textFrame('x')))).toBe(false)
    expect(isTransientOnlyChunk(chunk(seqFrame(1).slice(0, 30)))).toBe(false)
    expect(isTransientOnlyChunk(chunk(''))).toBe(false)
  })
})

describe('journal writes are coalesced over a short window (SHO-319)', () => {
  test('20 chunks pushed within the window produce one append', async () => {
    const journal = recordingJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: journal.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    for (let i = 0; i < 20; i++) forwarder.push(chunk(textFrame(`d${i}`)))
    await forwarder.drain()

    expect(journal.appends).toHaveLength(1)
    expect(journal.appends[0]).toHaveLength(20)
    expect(forwarded).toHaveLength(20)
  })

  test('drain() flushes the window instead of waiting it out', async () => {
    const journal = recordingJournal()
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: journal.writer,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    // A macrotask queued before the drain: if drain() waited for the batch
    // window, this would have fired first.
    let timerFired = false
    setTimeout(() => { timerFired = true }, 0)

    forwarder.push(chunk(textFrame('now')))
    await forwarder.drain()

    expect(timerFired).toBe(false)
    expect(journal.appends).toHaveLength(1)
    expect(forwarded).toEqual([textFrame('now')])
  })

  test('a turn with no journal still forwards on the next microtask', async () => {
    const forwarded: string[] = []
    const forwarder = createJournalledForwarder({
      journal: null,
      forward: (bytes) => forwarded.push(new TextDecoder().decode(bytes)),
    })

    forwarder.push(chunk('x'))
    await Promise.resolve()
    await Promise.resolve()
    expect(forwarded).toEqual(['x'])
  })
})
