// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the localhost -> public-preview link rewriting. Pins the two
 * guarantees: (1) user-facing localhost links are rewritten to the public URL,
 * and (2) the agent's own `curl` checks and code spans/fences are NEVER touched.
 */
import { describe, test, expect } from 'bun:test'
import { rewriteLocalhostLinks, LocalhostLinkRewriter } from './preview-link-rewrite'

const ORIGIN = 'https://demo.preview.shogo.ai'

describe('rewriteLocalhostLinks', () => {
  test('no-op when no public URL is provided (local dev)', () => {
    const input = 'open http://localhost:8080/dashboard'
    expect(rewriteLocalhostLinks(input, '')).toBe(input)
    expect(rewriteLocalhostLinks(input, undefined)).toBe(input)
  })

  test('rewrites a bare localhost URL, preserving the path', () => {
    expect(rewriteLocalhostLinks('open http://localhost:8080/dashboard now', ORIGIN)).toBe(
      `open ${ORIGIN}/dashboard now`,
    )
  })

  test('rewrites inside a markdown link without swallowing the closing paren', () => {
    expect(rewriteLocalhostLinks('[preview](http://localhost:8080/x)', ORIGIN)).toBe(
      `[preview](${ORIGIN}/x)`,
    )
  })

  test('rewrites a scheme-less localhost:port reference', () => {
    expect(rewriteLocalhostLinks('visit localhost:3000/app', ORIGIN)).toBe(`visit ${ORIGIN}/app`)
  })

  test('rewrites 127.0.0.1 and 0.0.0.0 hosts', () => {
    expect(rewriteLocalhostLinks('http://127.0.0.1:8080/y', ORIGIN)).toBe(`${ORIGIN}/y`)
    expect(rewriteLocalhostLinks('http://0.0.0.0:5173/z', ORIGIN)).toBe(`${ORIGIN}/z`)
  })

  test('strips a trailing slash on the public origin (no double slash)', () => {
    expect(rewriteLocalhostLinks('http://localhost:8080/a', `${ORIGIN}/`)).toBe(`${ORIGIN}/a`)
  })

  test('leaves localhost inside inline code untouched', () => {
    const input = 'use `http://localhost:8080/` here'
    expect(rewriteLocalhostLinks(input, ORIGIN)).toBe(input)
  })

  test('leaves localhost inside a fenced code block untouched', () => {
    const input = ['before', '```', 'http://localhost:8080/x', '```', 'after'].join('\n')
    expect(rewriteLocalhostLinks(input, ORIGIN)).toBe(input)
  })

  test('leaves a curl line untouched (internal check, not a link)', () => {
    const input = 'I ran curl http://localhost:8080/api/foo to check it'
    expect(rewriteLocalhostLinks(input, ORIGIN)).toBe(input)
  })

  test('rewrites a user-facing link even when a curl appears on a DIFFERENT line', () => {
    const input = ['curl http://localhost:8080/api', 'Open http://localhost:8080/ to view it'].join('\n')
    const out = rewriteLocalhostLinks(input, ORIGIN)
    expect(out).toBe(['curl http://localhost:8080/api', `Open ${ORIGIN}/ to view it`].join('\n'))
  })
})

describe('LocalhostLinkRewriter (streaming)', () => {
  test('rewrites a localhost URL split across deltas', () => {
    const rw = new LocalhostLinkRewriter(ORIGIN)
    let out = ''
    out += rw.push('see http://localh')
    out += rw.push('ost:8080/x end')
    out += rw.flush()
    expect(out).toBe(`see ${ORIGIN}/x end`)
  })

  test('is a pass-through when no public URL (local dev)', () => {
    const rw = new LocalhostLinkRewriter('')
    expect(rw.active).toBe(false)
    let out = ''
    out += rw.push('open http://localhost:8080/x')
    out += rw.flush()
    expect(out).toBe('open http://localhost:8080/x')
  })

  test('preserves code-span protection across deltas', () => {
    const rw = new LocalhostLinkRewriter(ORIGIN)
    let out = ''
    out += rw.push('use `http://localhost')
    out += rw.push(':8080/` then http://localhost:8080/live')
    out += rw.flush()
    // The backtick-wrapped reference is untouched; the bare one is rewritten.
    expect(out).toBe(`use \`http://localhost:8080/\` then ${ORIGIN}/live`)
  })
})
