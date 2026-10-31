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
import { createJournalledForwarder } from '../journalled-forwarder'
import type { TurnJournalWriter } from '../../services/chat-turn-journal'

const chunk = (text: string): Uint8Array => new TextEncoder().encode(text)

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
    await settle()

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
    await settle()
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
})
