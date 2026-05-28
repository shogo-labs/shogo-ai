// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Adversarial unit tests for the streaming OSC decoder.
 *
 * Every test in this file maps to a real-world breakage mode we found
 * while building Phase 3:
 *
 *   - "split mid-sequence across chunks"          → ConPTY 16 KiB chunking
 *   - "BEL vs ST terminator interchange"          → VS Code emits ST,
 *                                                   bash-preexec emits BEL
 *   - "C1 0x9D introducer / 0x9C ST"              → some old bash builds
 *   - "ESC inside payload"                        → P;Title=… with arrow keys
 *   - "malformed → resync"                        → noisy programs (vim,
 *                                                   git pager) emitting
 *                                                   stray ESCs
 *   - "overflow drops, doesn't hang"              → adversarial PTY stream
 */

import { describe, it, expect } from 'bun:test'
import { OscDecoder, decodeOscOneShot } from '../osc-decoder'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('OscDecoder — happy path', () => {
  it('strips a complete OSC 633 ; A BEL from the stream and emits the event', () => {
    const r = decodeOscOneShot(enc('hi\x1b]633;A\x07world'))
    expect(text(r.passthrough)).toBe('hiworld')
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'A', args: [] })
  })

  it('handles ST terminator (ESC \\) as well as BEL', () => {
    const r = decodeOscOneShot(enc('\x1b]633;B\x1b\\$ '))
    expect(text(r.passthrough)).toBe('$ ')
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'B' })
  })

  it('parses OSC 633 ; D ; <exitCode>', () => {
    const r = decodeOscOneShot(enc('\x1b]633;D;42\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'D', args: ['42'] })
  })

  it('parses OSC 633 ; P ; Cwd=/tmp', () => {
    const r = decodeOscOneShot(enc('\x1b]633;P;Cwd=/tmp\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'P', args: ['Cwd=/tmp'] })
  })

  it('parses OSC 633 ; E ; <commandline>', () => {
    const r = decodeOscOneShot(enc('\x1b]633;E;ls -la /etc\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'E', args: ['ls -la /etc'] })
  })

  it('parses OSC 133 ; A and translates to osc-133 event', () => {
    const r = decodeOscOneShot(enc('\x1b]133;A\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'osc-133', letter: 'A' })
  })

  it('parses OSC 133 ; D ; 0', () => {
    const r = decodeOscOneShot(enc('\x1b]133;D;0\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'osc-133', letter: 'D', args: ['0'] })
  })

  it('emits unknown-osc for non-633/133 (e.g. iTerm 1337)', () => {
    const r = decodeOscOneShot(enc('\x1b]1337;CurrentDir=/foo\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'unknown-osc', ps: '1337', pt: 'CurrentDir=/foo' })
    expect(text(r.passthrough)).toBe('')
  })

  it('emits unknown-osc without a Pt when only Ps is present', () => {
    const r = decodeOscOneShot(enc('\x1b]7\x07'))
    expect(r.events[0]).toMatchObject({ kind: 'unknown-osc', ps: '7', pt: '' })
  })
})

describe('OscDecoder — C1 introducer + ST', () => {
  it('accepts 0x9D as OSC introducer', () => {
    const buf = new Uint8Array([0x9d, 0x36, 0x33, 0x33, 0x3b, 0x41, 0x07]) // \x9D 633;A BEL
    const r = decodeOscOneShot(buf)
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'A' })
    expect(r.passthrough.length).toBe(0)
  })

  it('accepts 0x9C as ST terminator', () => {
    const buf = new Uint8Array([0x1b, 0x5d, 0x36, 0x33, 0x33, 0x3b, 0x43, 0x9c]) // ESC ] 633;C 0x9C
    const r = decodeOscOneShot(buf)
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'C' })
  })

  it('drops a bare C1 ST outside an OSC (ESC \\)', () => {
    const r = decodeOscOneShot(enc('abc\x1b\\def'))
    expect(text(r.passthrough)).toBe('abcdef')
    expect(r.events).toHaveLength(0)
  })
})

describe('OscDecoder — split across feed() calls', () => {
  it('handles a sequence split between ESC and ]', () => {
    const d = new OscDecoder()
    const a = d.feed(enc('pre\x1b'))
    const b = d.feed(enc(']633;A\x07post'))
    expect(text(a.passthrough)).toBe('pre')
    expect(text(b.passthrough)).toBe('post')
    expect(a.events).toHaveLength(0)
    expect(b.events).toHaveLength(1)
    expect(b.events[0]).toMatchObject({ kind: 'osc-633', letter: 'A' })
  })

  it('handles split mid-payload', () => {
    const d = new OscDecoder()
    expect(d.feed(enc('\x1b]633;P;Cw')).events).toHaveLength(0)
    expect(d.feed(enc('d=/tmp\x07')).events[0]).toMatchObject({
      kind: 'osc-633',
      letter: 'P',
      args: ['Cwd=/tmp'],
    })
  })

  it('handles ST split between ESC and backslash', () => {
    const d = new OscDecoder()
    expect(d.feed(enc('\x1b]633;C\x1b')).events).toHaveLength(0)
    const r = d.feed(enc('\\done'))
    expect(text(r.passthrough)).toBe('done')
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'C' })
  })

  it('feeds bytes one at a time and still produces the same result', () => {
    const d = new OscDecoder()
    const events: unknown[] = []
    let pass = ''
    const stream = enc('hi\x1b]633;D;7\x1b\\bye')
    for (let i = 0; i < stream.length; i++) {
      const r = d.feed(stream.subarray(i, i + 1))
      pass += text(r.passthrough)
      events.push(...r.events)
    }
    expect(pass).toBe('hibye')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'osc-633', letter: 'D', args: ['7'] })
  })
})

describe('OscDecoder — malformed / resync', () => {
  it('flushes a stray ESC followed by a non-]/\\ byte', () => {
    const r = decodeOscOneShot(enc('a\x1bZb'))
    expect(text(r.passthrough)).toBe('a\x1bZb')
    expect(r.events).toHaveLength(0)
  })

  it('continues decoding after a stray ESC', () => {
    const r = decodeOscOneShot(enc('a\x1bZ\x1b]633;A\x07b'))
    expect(text(r.passthrough)).toBe('a\x1bZb')
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'A' })
  })

  it('allows an ESC byte inside an OSC payload without breaking out (legal)', () => {
    // Some apps embed an ESC (not followed by \) inside a P value. The
    // sequence terminates only on BEL or true ESC \.
    const payload = new Uint8Array([
      0x1b, 0x5d, // ESC ]
      0x36, 0x33, 0x33, 0x3b, 0x50, 0x3b, // 633;P;
      0x58, 0x3d, 0x1b, 0x59, // X=ESC Y
      0x07, // BEL
    ])
    const r = decodeOscOneShot(payload)
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ kind: 'osc-633', letter: 'P' })
    // ESC and Y survive inside the arg
    expect((r.events[0] as { args: string[] }).args[0]).toContain('\x1bY')
  })

  it('does not leak OSC bytes into passthrough on a long run', () => {
    const r = decodeOscOneShot(enc('A\x1b]633;A\x07B\x1b]633;B\x1b\\C\x1b]633;D;0\x07D'))
    expect(text(r.passthrough)).toBe('ABCD')
    expect(r.events.map((e) => (e as { letter?: string }).letter)).toEqual(['A', 'B', 'D'])
  })
})

describe('OscDecoder — overflow', () => {
  it('drops payloads larger than maxPayloadBytes and resyncs', () => {
    const d = new OscDecoder({ maxPayloadBytes: 64 })
    const big = '\x1b]633;P;' + 'x'.repeat(200) + '\x07after'
    const r = d.feed(enc(big))
    // Overflow event present
    expect(r.events.some((e) => e.kind === 'overflow')).toBe(true)
    // 'after' is recovered as passthrough (some of the 'x's are also flushed
    // once we exit OSC mode — what matters is that we did NOT hang and we
    // DID reach 'after'). Assert the suffix.
    expect(text(r.passthrough).endsWith('after')).toBe(true)
  })

  it('after overflow, a subsequent well-formed OSC still parses', () => {
    const d = new OscDecoder({ maxPayloadBytes: 64 })
    d.feed(enc('\x1b]633;P;' + 'x'.repeat(200)))
    // Force resync — close the broken OSC by feeding a BEL (decoder is
    // back in Ground after overflow, so BEL is passthrough; harmless).
    const r = d.feed(enc('\x07\x1b]633;A\x07'))
    expect(r.events.some((e) => e.kind === 'osc-633' && (e as { letter: string }).letter === 'A')).toBe(true)
  })
})

describe('OscDecoder — invariants', () => {
  it('passthrough is always a fresh allocation (no aliasing)', () => {
    const d = new OscDecoder()
    const input = enc('hello')
    const r = d.feed(input)
    expect(r.passthrough).not.toBe(input)
    // Mutate input — passthrough must not change.
    input[0] = 0
    expect(text(r.passthrough)).toBe('hello')
  })

  it('returns empty passthrough and zero events when fed an empty chunk', () => {
    const d = new OscDecoder()
    const r = d.feed(new Uint8Array(0))
    expect(r.passthrough.length).toBe(0)
    expect(r.events).toHaveLength(0)
  })

  it('state survives across chunks until terminator (state machine is stateful)', () => {
    const d = new OscDecoder()
    d.feed(enc('\x1b]')) // entered OscPayload
    expect(d._stateForTest().state).toBe(2)
    d.feed(enc('633;A\x07'))
    expect(d._stateForTest().state).toBe(0)
  })
})
