// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  extractMeta,
  findIncompleteTailIndex,
  META_SENTINEL_RE,
  UNTERMINATED_SENTINEL_RE,
} from '../meta-sentinel'

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

describe('extractMeta', () => {
  test('returns no meta and unchanged buf when no sentinel is present', () => {
    const out = extractMeta('hello world\nls -la\n')
    expect(out.meta).toBeNull()
    expect(out.rest).toBe('hello world\nls -la\n')
  })

  test('decodes a complete sentinel and removes it from the buf', () => {
    const meta = { cwd: '/tmp', exitCode: 0, signal: null }
    const before = 'output line 1\noutput line 2\n'
    // The on-wire framing is `…\u001e\n` — the regex's `\n?` greedily
    // swallows the trailing newline as part of the sentinel, so callers
    // see clean output without an extra blank line.
    const buf = before + encodeMeta(meta) + '\n'

    const out = extractMeta(buf)
    expect(out.meta).toEqual(meta)
    expect(out.rest).toBe(before)
  })

  test('decodes a complete sentinel followed by additional output', () => {
    const meta = { cwd: '/tmp', exitCode: 0 }
    const before = 'output\n'
    const after = 'follow-up text'
    const buf = before + encodeMeta(meta) + after
    const out = extractMeta(buf)
    expect(out.meta).toEqual(meta)
    expect(out.rest).toBe(before + after)
  })

  test('strips the optional trailing newline emitted alongside the sentinel', () => {
    const meta = { cwd: '/x', exitCode: 1 }
    const buf = `prefix${encodeMeta(meta)}\n`
    const out = extractMeta(buf)
    expect(out.meta).toEqual(meta)
    expect(out.rest).toBe('prefix')
  })

  test('returns no meta when the closing byte is missing (incomplete sentinel)', () => {
    const partial = `pre${SENTINEL_PREFIX}eyJjd2QiOiIvIn0=`
    const out = extractMeta(partial)
    expect(out.meta).toBeNull()
    expect(out.rest).toBe(partial)
  })

  test('decodes meta=null when the base64 payload is malformed', () => {
    const buf = `pre${SENTINEL_PREFIX}!!!not-base64!!!${SENTINEL_SUFFIX}post`
    const out = extractMeta(buf)
    // The sentinel is matched by the regex but JSON.parse of the decoded
    // payload throws → meta becomes null. The bytes are still removed.
    // The regex requires base64-charset only, so the regex doesn't match
    // and the buf is returned unchanged.
    expect(out.meta).toBeNull()
    expect(out.rest).toBe(buf)
  })

  test('decodes meta=null when the JSON payload is invalid', () => {
    const b64 = Buffer.from('not json', 'utf8').toString('base64')
    const buf = `pre${SENTINEL_PREFIX}${b64}${SENTINEL_SUFFIX}post`
    const out = extractMeta(buf)
    expect(out.meta).toBeNull()
    // Even when JSON.parse fails the malformed sentinel is still consumed.
    expect(out.rest).toBe('prepost')
  })

  test('only strips the first complete sentinel; callers loop for more', () => {
    const a = encodeMeta({ cwd: '/a', exitCode: 0 })
    const b = encodeMeta({ cwd: '/b', exitCode: 1 })
    const buf = `pre${a}mid${b}post`
    const first = extractMeta(buf)
    expect(first.meta).toEqual({ cwd: '/a', exitCode: 0 })
    expect(first.rest).toBe(`premid${b}post`)
    const second = extractMeta(first.rest)
    expect(second.meta).toEqual({ cwd: '/b', exitCode: 1 })
    expect(second.rest).toBe('premidpost')
  })
})

describe('findIncompleteTailIndex', () => {
  test('returns -1 when the buf has no 0x1E byte', () => {
    expect(findIncompleteTailIndex('hello world\n')).toBe(-1)
  })

  test('returns the index of the latest 0x1E (could-be sentinel start)', () => {
    const buf = `prefix\u001eSHOGO_TERM_META:abc`
    expect(findIncompleteTailIndex(buf)).toBe(buf.indexOf('\u001e'))
  })
})

describe('UNTERMINATED_SENTINEL_RE', () => {
  test('matches a sentinel prefix without the closing byte', () => {
    expect(UNTERMINATED_SENTINEL_RE.test(`${SENTINEL_PREFIX}YWJjZA==`)).toBe(true)
    expect(UNTERMINATED_SENTINEL_RE.test(SENTINEL_PREFIX)).toBe(true)
  })

  test('does not match a fully closed sentinel', () => {
    const closed = `${SENTINEL_PREFIX}YWJjZA==${SENTINEL_SUFFIX}`
    expect(UNTERMINATED_SENTINEL_RE.test(closed)).toBe(false)
  })

  test('does not match arbitrary text', () => {
    expect(UNTERMINATED_SENTINEL_RE.test('plain output')).toBe(false)
  })
})

test('META_SENTINEL_RE is exported and matches the canonical wire format', () => {
  const sample = encodeMeta({ cwd: '/x' })
  expect(META_SENTINEL_RE.test(sample)).toBe(true)
})
