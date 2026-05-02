// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { finish, makeDecoderState, pushChunk } from '../run-stream-decoder'

const SENTINEL_PREFIX = '\u001eSHOGO_TERM_META:'
const SENTINEL_SUFFIX = '\u001e'

function encodeMeta(payload: object): string {
  const json = JSON.stringify(payload)
  const b64 =
    typeof btoa === 'function'
      ? btoa(json)
      : Buffer.from(json, 'utf8').toString('base64')
  return `${SENTINEL_PREFIX}${b64}${SENTINEL_SUFFIX}`
}

describe('run-stream-decoder', () => {
  test('passes plain output through unchanged when no sentinel is present', () => {
    const state = makeDecoderState()
    const r1 = pushChunk(state, 'hello\n')
    const r2 = pushChunk(state, 'world\n')
    expect(r1.visible).toBe('hello\n')
    expect(r2.visible).toBe('world\n')
    expect(state.meta).toBeNull()
  })

  test('strips a complete sentinel at end-of-stream and surfaces meta', () => {
    const state = makeDecoderState()
    const meta = { cwd: '/tmp', exitCode: 0, signal: null }
    const sentinel = encodeMeta(meta)

    const r = pushChunk(state, `output line\n${sentinel}`)
    expect(r.visible).toBe('output line\n')
    expect(r.meta).toEqual(meta)
    expect(state.meta).toEqual(meta)
  })

  test('holds back a 0x1E byte at the end of a chunk that could be a sentinel start', () => {
    const state = makeDecoderState()
    // Chunk 1 ends with the opening 0x1E — the decoder MUST NOT leak it.
    const r1 = pushChunk(state, 'output\n\u001e')
    expect(r1.visible).toBe('output\n')
    expect(r1.meta).toBeNull()

    // Chunk 2 completes the sentinel and is consumed entirely.
    const meta = { cwd: '/x', exitCode: 1 }
    const b64 =
      typeof btoa === 'function'
        ? btoa(JSON.stringify(meta))
        : Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
    const r2 = pushChunk(state, `SHOGO_TERM_META:${b64}${SENTINEL_SUFFIX}`)
    expect(r2.visible).toBe('')
    expect(r2.meta).toEqual(meta)
  })

  test('handles a sentinel split across many chunk boundaries', () => {
    const state = makeDecoderState()
    const meta = { cwd: '/y', exitCode: 0 }
    const sentinel = encodeMeta(meta)
    // Stream byte-by-byte to maximise straddle chances.
    let visibleAcc = ''
    for (const ch of `prefix${sentinel}\n`) {
      const r = pushChunk(state, ch)
      visibleAcc += r.visible
    }
    visibleAcc += finish(state).visible
    expect(visibleAcc).toBe('prefix')
    expect(state.meta).toEqual(meta)
  })

  test('finish() drops an unterminated sentinel rather than leaking it', () => {
    const state = makeDecoderState()
    const r1 = pushChunk(state, `hello${SENTINEL_PREFIX}YWJjZA==`)
    expect(r1.visible).toBe('hello')
    // The pending tail is the unterminated sentinel.
    const r2 = finish(state)
    expect(r2.visible).toBe('')
    expect(r2.meta).toBeNull()
  })

  test('multiple complete sentinels in a single push yield the latest meta', () => {
    const state = makeDecoderState()
    const a = encodeMeta({ cwd: '/a', exitCode: 0 })
    const b = encodeMeta({ cwd: '/b', exitCode: 1 })
    const r = pushChunk(state, `pre${a}mid${b}post`)
    expect(r.visible).toBe('premidpost')
    // Most recent wins (in practice the server emits one).
    expect(state.meta).toEqual({ cwd: '/b', exitCode: 1 })
  })

  test('plain output is fully emitted by pushChunk; finish() returns nothing', () => {
    const state = makeDecoderState()
    const r = pushChunk(state, 'tail-no-sentinel')
    expect(r.visible).toBe('tail-no-sentinel')
    // Without a 0x1E byte there is no held-back tail, so finish has
    // nothing left to emit.
    expect(finish(state).visible).toBe('')
  })

  test('a held-back partial sentinel that becomes a real sentinel by finish() drains correctly', () => {
    const state = makeDecoderState()
    // Held back across the boundary: the leading 0x1E might have been a
    // sentinel start.
    pushChunk(state, 'visible\u001e')
    expect(state.pending).toBe('\u001e')
    // finish() sees only the 0x1E + nothing else — that doesn't match
    // UNTERMINATED_SENTINEL_RE (no `SHOGO_TERM_META:` prefix), so it
    // falls through and emits the leftover byte verbatim.
    const out = finish(state)
    expect(out.visible).toBe('\u001e')
    expect(out.meta).toBeNull()
  })
})
