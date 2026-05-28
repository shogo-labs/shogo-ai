// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { ScrollbackRing } from '../scrollback-ring'

const u = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('ScrollbackRing — construction', () => {
  it('coerces NaN capacity to 0', () => {
    const r = new ScrollbackRing(NaN)
    expect(r.capacity).toBe(0)
  })
  it('floors negative capacity to 0', () => {
    const r = new ScrollbackRing(-100)
    expect(r.capacity).toBe(0)
  })
  it('truncates non-integer capacity', () => {
    const r = new ScrollbackRing(10.9)
    expect(r.capacity).toBe(10)
  })
  it('starts empty (size=0, oldestSeq=0)', () => {
    const r = new ScrollbackRing(1024)
    expect(r.size).toBe(0)
    expect(r.oldestSeq).toBe(0)
  })
})

describe('ScrollbackRing — append', () => {
  it('ignores zero-length chunks', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, new Uint8Array(0))
    expect(r.size).toBe(0)
    expect(r.oldestSeq).toBe(0)
  })
  it('records firstRetainedSeq from the first non-empty append', () => {
    const r = new ScrollbackRing(1024)
    r.append(5, u('hi'))
    expect(r.oldestSeq).toBe(5)
    expect(r.size).toBe(2)
  })
  it('accumulates byte counts across appends', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, u('abc'))
    r.append(2, u('defgh'))
    expect(r.size).toBe(8)
  })
})

describe('ScrollbackRing — eviction', () => {
  it('evicts oldest chunks once total bytes exceed capacity', () => {
    const r = new ScrollbackRing(6)
    r.append(1, u('abc'))      // 3 bytes
    r.append(2, u('def'))      // 6 bytes total — at limit, no eviction
    expect(r.size).toBe(6)
    expect(r.oldestSeq).toBe(1)
    r.append(3, u('gh'))       // 8 → evict seq=1 → 5 bytes
    expect(r.size).toBe(5)
    expect(r.oldestSeq).toBe(2)
  })
  it('never evicts the only remaining chunk, even if it overflows capacity', () => {
    const r = new ScrollbackRing(4)
    r.append(1, u('hello'))
    expect(r.size).toBe(5)
    expect(r.oldestSeq).toBe(1)
  })
  it('updates oldestSeq to the new head after multi-chunk eviction', () => {
    const r = new ScrollbackRing(5)
    r.append(1, u('aa'))
    r.append(2, u('bb'))
    r.append(3, u('cc'))
    r.append(4, u('dddd'))     // forces multiple evictions
    expect(r.oldestSeq).toBe(4)
  })
})

describe('ScrollbackRing — replaySince', () => {
  it('returns empty when ring is empty', () => {
    const r = new ScrollbackRing(1024)
    const out = r.replaySince(7)
    expect(out.bytes.byteLength).toBe(0)
    expect(out.latestSeq).toBe(7)
    expect(out.truncated).toBe(false)
  })
  it('concatenates chunks strictly after sinceSeq', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, u('A'))
    r.append(2, u('B'))
    r.append(3, u('C'))
    const out = r.replaySince(1)
    expect(text(out.bytes)).toBe('BC')
    expect(out.latestSeq).toBe(3)
    expect(out.truncated).toBe(false)
  })
  it('treats sinceSeq=0 as "give me everything" and never reports truncated', () => {
    const r = new ScrollbackRing(2)
    r.append(1, u('aa'))
    r.append(2, u('bb'))           // evicts seq=1
    const out = r.replaySince(0)
    expect(text(out.bytes)).toBe('bb')
    expect(out.truncated).toBe(false)
  })
  it('reports truncated when caller wants a seq we evicted', () => {
    const r = new ScrollbackRing(2)
    r.append(1, u('aa'))
    r.append(2, u('bb'))
    r.append(3, u('cc'))           // oldest now seq=3 (size cap holds 1 chunk + overflow)
    const out = r.replaySince(1)   // wants seq>=2 but oldest is 3
    expect(out.truncated).toBe(true)
  })
  it('does not report truncated when the requested seq is still on-disk', () => {
    const r = new ScrollbackRing(1024)
    r.append(5, u('xx'))
    r.append(6, u('yy'))
    const out = r.replaySince(5)
    expect(out.truncated).toBe(false)
    expect(text(out.bytes)).toBe('yy')
  })
  it('returns empty bytes (but correct latestSeq) when sinceSeq is at-or-after the newest chunk', () => {
    const r = new ScrollbackRing(1024)
    r.append(1, u('A'))
    r.append(2, u('B'))
    const out = r.replaySince(2)
    expect(out.bytes.byteLength).toBe(0)
    expect(out.latestSeq).toBe(2)
  })
})
