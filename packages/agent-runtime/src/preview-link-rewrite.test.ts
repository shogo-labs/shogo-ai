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

describe('rewriteLocalhostLinks — own ports inside code and curl lines (SHO-239)', () => {
  // Mirrors `LOCALHOST_RE` in e2e/staging/agent-chat.ts — the assertion the
  // staging critical-path gate makes on the agent's own reply text.
  const LOCALHOST_RE =
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?|(?:\blocalhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}/i
  const OWN_PORTS = [8080, 37256]

  test('the reply that failed the staging gate comes out clean', () => {
    const input = [
      'Verified:',
      '  Build clean (built in 1337ms), no type/lint errors',
      '  `localhost:8080` → 200, public URL → 200',
      `  Preview URL: ${ORIGIN}`,
    ].join('\n')
    const out = rewriteLocalhostLinks(input, ORIGIN, { ownPorts: OWN_PORTS })
    expect(out).not.toMatch(LOCALHOST_RE)
    expect(out).toBe(
      [
        'Verified:',
        '  Build clean (built in 1337ms), no type/lint errors',
        `  \`${ORIGIN}\` → 200, public URL → 200`,
        `  Preview URL: ${ORIGIN}`,
      ].join('\n'),
    )
  })

  test('rewrites an own-port URL inside a fence, preserving the path', () => {
    const input = ['```', 'http://127.0.0.1:8080/x', '```'].join('\n')
    expect(rewriteLocalhostLinks(input, ORIGIN, { ownPorts: OWN_PORTS })).toBe(
      ['```', `${ORIGIN}/x`, '```'].join('\n'),
    )
  })

  test('rewrites the API sidecar port on a curl line', () => {
    const input = 'I ran curl -s http://localhost:37256/api/todos'
    expect(rewriteLocalhostLinks(input, ORIGIN, { ownPorts: OWN_PORTS })).toBe(
      `I ran curl -s ${ORIGIN}/api/todos`,
    )
  })

  test('leaves other ports in code untouched', () => {
    const input = [
      'connect with `postgres://u@localhost:5432/db`',
      '```',
      'localhost:5173',
      '```',
    ].join('\n')
    expect(rewriteLocalhostLinks(input, ORIGIN, { ownPorts: OWN_PORTS })).toBe(input)
  })

  test('leaves a bare localhost in code untouched', () => {
    const input = "set `host: 'localhost'` in the config"
    expect(rewriteLocalhostLinks(input, ORIGIN, { ownPorts: OWN_PORTS })).toBe(input)
  })

  test('is byte-identical locally even with own ports set', () => {
    const input = 'Verified: `localhost:8080` → 200\ncurl -s http://localhost:37256/api/todos'
    expect(rewriteLocalhostLinks(input, '', { ownPorts: OWN_PORTS })).toBe(input)
    expect(rewriteLocalhostLinks(input, undefined, { ownPorts: OWN_PORTS })).toBe(input)
  })
})

describe('LocalhostLinkRewriter (streaming)', () => {
  test('rewrites an own port split across deltas and keeps code parity', () => {
    const rw = new LocalhostLinkRewriter(ORIGIN, undefined, [8080, 37256])
    let out = ''
    out += rw.push('`localhost:80')
    out += rw.push('80` → 200, then http://localhost:8080/live')
    out += rw.flush()
    expect(out).toBe(`\`${ORIGIN}\` → 200, then ${ORIGIN}/live`)
  })

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
