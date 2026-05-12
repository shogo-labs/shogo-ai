// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { ScrollbackRing } from '../pty-scrollback'

const enc = new TextEncoder()

describe('ScrollbackRing', () => {
  test('returns nothing when empty, with sinceSeq preserved', () => {
    const r = new ScrollbackRing(1024)
    const got = r.replaySince(7)
    expect(got.bytes.byteLength).toBe(0)
    expect(got.latestSeq).toBe(7)
    expect(got.truncated).toBe(false)
  })

  test('appends and replays full content for sinceSeq=0', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, enc.encode('hello '))
    r.append(2, enc.encode('world'))
    const got = r.replaySince(0)
    expect(new TextDecoder().decode(got.bytes)).toBe('hello world')
    expect(got.latestSeq).toBe(2)
    expect(got.truncated).toBe(false)
  })

  test('replays only chunks newer than sinceSeq', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, enc.encode('one'))
    r.append(2, enc.encode('two'))
    r.append(3, enc.encode('three'))
    const got = r.replaySince(2)
    expect(new TextDecoder().decode(got.bytes)).toBe('three')
    expect(got.latestSeq).toBe(3)
  })

  test('replaying with sinceSeq >= latest returns nothing', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, enc.encode('only'))
    const got = r.replaySince(1)
    expect(got.bytes.byteLength).toBe(0)
    expect(got.latestSeq).toBe(1)
  })

  test('evicts oldest chunks when over capacity', () => {
    const r = new ScrollbackRing(8) // tiny on purpose
    r.append(1, enc.encode('aaaa')) // 4 bytes
    r.append(2, enc.encode('bbbb')) // 8
    r.append(3, enc.encode('cccc')) // would be 12 → evict #1
    expect(r.size).toBe(8)
    expect(r.oldestSeq).toBe(2)
    const got = r.replaySince(0)
    expect(new TextDecoder().decode(got.bytes)).toBe('bbbbcccc')
    expect(got.latestSeq).toBe(3)
  })

  test('flags truncated when sinceSeq has been evicted', () => {
    const r = new ScrollbackRing(8)
    r.append(1, enc.encode('aaaa'))
    r.append(2, enc.encode('bbbb'))
    r.append(3, enc.encode('cccc')) // evicts seq 1
    const got = r.replaySince(1) // user wanted seq 2+, but seq 1 is gone too — actually seq 1 is gone, want seq 2+ which is fine
    // The check is: did we evict any chunks <= sinceSeq we'd otherwise have given?
    // sinceSeq=1 means "give me chunks > 1". Oldest in ring is seq 2. No truncation.
    expect(got.truncated).toBe(false)
    expect(new TextDecoder().decode(got.bytes)).toBe('bbbbcccc')

    const got2 = r.replaySince(0) // wants everything from start, seq 1 was dropped
    expect(got2.truncated).toBe(false) // sinceSeq=0 is the "full ring" sentinel
    const got3 = new ScrollbackRing(8)
    got3.append(5, enc.encode('aaaa'))
    got3.append(6, enc.encode('bbbb'))
    got3.append(7, enc.encode('cccc')) // evicts seq 5; oldest now 6
    const got4 = got3.replaySince(3) // wants seq 4+; oldest is 6 → gap → truncated
    expect(got4.truncated).toBe(true)
    expect(new TextDecoder().decode(got4.bytes)).toBe('bbbbcccc')
  })

  test('keeps a single chunk that exceeds capacity (best-effort)', () => {
    const r = new ScrollbackRing(8)
    r.append(1, enc.encode('x'.repeat(100)))
    const got = r.replaySince(0)
    expect(got.bytes.byteLength).toBe(100)
    expect(got.latestSeq).toBe(1)
  })

  test('zero-byte append is a no-op', () => {
    const r = new ScrollbackRing(8)
    r.append(1, new Uint8Array(0))
    expect(r.size).toBe(0)
    expect(r.oldestSeq).toBe(0)
  })
})
