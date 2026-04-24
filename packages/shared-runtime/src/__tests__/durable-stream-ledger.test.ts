// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DurableStreamLedger } from '../durable-stream-ledger'

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

describe('DurableStreamLedger', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('persists chunks and replays them from a new instance', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-ledger-'))
    const first = new DurableStreamLedger(dir)
    const meta = first.start('chat-1', { turnId: 'turn-1', runtimeId: 'runtime-a' })
    expect(meta.turnId).toBe('turn-1')

    first.appendChunk('chat-1', encode('hello '))
    first.appendChunk('chat-1', encode('world'))
    first.complete('chat-1')

    const second = new DurableStreamLedger(dir)
    const replay = second.createReplayStream('chat-1')
    expect(replay).not.toBeNull()
    expect(await collectStream(replay!)).toBe('hello world')
  })

  test('replays only events after fromSeq', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-ledger-'))
    const ledger = new DurableStreamLedger(dir)
    ledger.start('chat-1', { turnId: 'turn-1' })
    ledger.appendChunk('chat-1', encode('a'))
    ledger.appendChunk('chat-1', encode('b'))
    ledger.appendChunk('chat-1', encode('c'))

    const replay = ledger.createReplayStream('chat-1', { fromSeq: 1 })
    expect(replay).not.toBeNull()
    expect(await collectStream(replay!)).toBe('bc')
  })

  test('rejects mismatched turn ids and aborted streams', () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-ledger-'))
    const ledger = new DurableStreamLedger(dir)
    ledger.start('chat-1', { turnId: 'turn-1' })
    ledger.appendChunk('chat-1', encode('a'))

    expect(ledger.createReplayStream('chat-1', { turnId: 'turn-2' })).toBeNull()
    ledger.abort('chat-1')
    expect(ledger.createReplayStream('chat-1', { turnId: 'turn-1' })).toBeNull()
  })

  test('interrupted streams remain replayable with recoverable status', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-ledger-'))
    const ledger = new DurableStreamLedger(dir)
    ledger.start('chat-1', { turnId: 'turn-1' })
    ledger.appendChunk('chat-1', encode('partial'))
    ledger.interrupt('chat-1')

    expect(ledger.getMeta('chat-1')?.status).toBe('interrupted_recoverable')
    const replay = ledger.createReplayStream('chat-1', { turnId: 'turn-1' })
    expect(replay).not.toBeNull()
    expect(await collectStream(replay!)).toBe('partial')
  })
})
