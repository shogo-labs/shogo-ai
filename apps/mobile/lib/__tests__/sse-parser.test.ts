// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The SSE parser behind the native `EventSource` stand-in (SHO-580).
 *
 * The old inline parser in `polyfills.ts` dropped events in three ways that
 * looked fine against our own single-line `data:` frames and broke against
 * anything else: multi-line `data:` was concatenated with no separator, named
 * events were revealed as `message` (or lost), and `\r\n` line endings left a
 * stray `\r` on every value. It also only kept `_lastIdx` into a `responseText`
 * the transport never trimmed, so cost grew with the life of the connection.
 */

import { describe, expect, it } from 'bun:test'
import { MAX_SSE_BUFFER_CHARS, SSEParser } from '../sse-parser'

function parseAll(chunks: string[]): Array<{ type: string; data: string; lastEventId: string }> {
  const parser = new SSEParser()
  const out: Array<{ type: string; data: string; lastEventId: string }> = []
  for (const chunk of chunks) out.push(...parser.push(chunk))
  return out
}

describe('SSEParser', () => {
  it('parses a plain data frame', () => {
    expect(parseAll(['data: hello\n\n'])).toEqual([
      { type: 'message', data: 'hello', lastEventId: '' },
    ])
  })

  it('joins multi-line data with a newline', () => {
    expect(parseAll(['data: line one\ndata: line two\ndata:line three\n\n'])[0].data).toBe(
      'line one\nline two\nline three',
    )
  })

  it('tracks id and attaches it to the event', () => {
    const events = parseAll(['id: 42\ndata: first\n\n', 'data: second\n\n'])
    expect(events[0].lastEventId).toBe('42')
    // The id persists for later events, as the format specifies.
    expect(events[1].lastEventId).toBe('42')
  })

  it('dispatches named events under their own type', () => {
    const events = parseAll(['event: presence\ndata: {"online":1}\n\n'])
    expect(events).toEqual([
      { type: 'presence', data: '{"online":1}', lastEventId: '' },
    ])
  })

  it('accepts CRLF and bare CR line endings', () => {
    expect(parseAll(['data: crlf\r\n\r\n'])[0].data).toBe('crlf')
    // Bare CR is a line break too. The blank line that ends the last block is
    // only knowable once one more byte arrives — an unterminated block is not
    // dispatched, which is also what the format requires at end of stream.
    expect(parseAll(['data: one\r\rdata: two\r\r']).map((e) => e.data)).toEqual(['one'])
    expect(parseAll(['data: one\r\rdata: two\r\r', '\n']).map((e) => e.data)).toEqual(['one', 'two'])
  })

  it('handles a CRLF split across two chunks', () => {
    const events = parseAll(['data: split\r', '\n\r\n'])
    expect(events.map((e) => e.data)).toEqual(['split'])
  })

  it('ignores comments and keep-alives', () => {
    expect(parseAll([': keep-alive\n\n', 'data: real\n\n'])).toEqual([
      { type: 'message', data: 'real', lastEventId: '' },
    ])
  })

  it('does not dispatch a block with no data', () => {
    expect(parseAll(['event: nothing\n\n', ': comment\n\n'])).toEqual([])
  })

  it('parses an event split across chunks exactly once', () => {
    const events = parseAll(['data: par', 'tial\n', '\n'])
    expect(events.map((e) => e.data)).toEqual(['partial'])
  })

  it('keeps only the unparsed tail between pushes', () => {
    const parser = new SSEParser()
    parser.push('data: one\n\ndata: two')
    // Everything up to the last boundary is consumed; only `data: two` is held.
    expect(parser.buffered).toBe('data: two'.length)
  })

  it('drops an unterminated block past the cap instead of growing forever', () => {
    const parser = new SSEParser()
    parser.push(`data: ${'x'.repeat(MAX_SSE_BUFFER_CHARS + 10)}`)
    expect(parser.buffered).toBe(0)
    expect(parser.dropped).toBe(1)
    // The parser is still usable afterwards.
    expect(parser.push('\n\ndata: after\n\n').map((e) => e.data)).toEqual(['after'])
  })

  it('parses 10k events over one connection once each, with a flat buffer', () => {
    const parser = new SSEParser()
    const seen: string[] = []
    let peakBuffer = 0
    // Delivered in uneven chunks, the way a slow network hands them over.
    let pending = ''
    for (let i = 0; i < 10_000; i++) {
      pending += `id: ${i}\ndata: {"i":${i}}\n\n`
      if (i % 7 === 0) {
        seen.push(...parser.push(pending).map((e) => e.data))
        peakBuffer = Math.max(peakBuffer, parser.buffered)
        pending = ''
      }
    }
    seen.push(...parser.push(pending).map((e) => e.data))

    expect(seen).toHaveLength(10_000)
    expect(new Set(seen).size).toBe(10_000)
    expect(seen[0]).toBe('{"i":0}')
    expect(seen[9_999]).toBe('{"i":9999}')
    expect(parser.id).toBe('9999')
    expect(peakBuffer).toBeLessThan(2_000)
  })
})
