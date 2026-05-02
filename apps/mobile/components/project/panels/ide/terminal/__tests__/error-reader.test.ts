// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readTerminalError } from '../error-reader'

function jsonResponse(body: unknown, status = 500): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function htmlResponse(body: string, status = 502): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function textResponse(body: string, status = 500): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

describe('readTerminalError', () => {
  test('JSON body with object error pulls .message out', async () => {
    const err = await readTerminalError(
      jsonResponse({ error: { code: 'X', message: 'boom' } }),
      'fallback',
    )
    expect(err.message).toBe('boom')
  })

  test('JSON body with string error returns the string', async () => {
    const err = await readTerminalError(jsonResponse({ error: 'plain' }), 'fb')
    expect(err.message).toBe('plain')
  })

  test('JSON body with no error field falls back to the supplied fallback', async () => {
    const err = await readTerminalError(jsonResponse({}), 'fallback')
    expect(err.message).toBe('fallback')
  })

  test('JSON body that fails to parse falls back', async () => {
    const res = new Response('not json', {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
    const err = await readTerminalError(res, 'fallback')
    expect(err.message).toBe('fallback')
  })

  test('HTML body strips tags and prepends the fallback', async () => {
    const err = await readTerminalError(
      htmlResponse('<html><body><h1>Bad Gateway</h1></body></html>'),
      'Terminal endpoint returned HTML instead of command output',
    )
    expect(err.message).toContain('Terminal endpoint returned HTML instead of command output')
    expect(err.message).toContain('Bad Gateway')
    // Tags must not leak.
    expect(err.message).not.toContain('<h1>')
  })

  test('plain-text body trimmed and capped at 160 chars after fallback prefix', async () => {
    const big = 'x'.repeat(500)
    const err = await readTerminalError(textResponse(big), 'fallback')
    expect(err.message.startsWith('fallback: ')).toBe(true)
    // The trimmed body slice is capped at 160 chars.
    expect(err.message.length).toBeLessThanOrEqual('fallback: '.length + 160)
  })

  test('empty body returns just the fallback', async () => {
    const err = await readTerminalError(textResponse(''), 'just fallback')
    expect(err.message).toBe('just fallback')
  })
})
