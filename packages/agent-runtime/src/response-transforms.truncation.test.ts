// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (P0): a large integration payload (e.g. a Google Doc body) was
 * truncated before the model saw it, but the only hint was an inline
 * "[N chars omitted]" buried inside the field — agents missed it and answered
 * from the partial content.
 *
 * These tests pin the fixed behavior: any truncation must surface a
 * machine-readable, top-level `_truncation` signal that names what was cut and
 * tells the agent how to recover the full value.
 */
import { describe, test, expect } from 'bun:test'
import { smartTruncateJson } from './response-transforms'

describe('smartTruncateJson — structured truncation signal', () => {
  test('small payloads are not truncated and round-trip exactly', () => {
    const data = { a: 1, b: 'short' }
    const { result, truncated } = smartTruncateJson(data, 12000)
    expect(truncated).toBe(false)
    expect(JSON.parse(result)).toEqual(data)
  })

  test('a stripped large field yields valid JSON with a top-level _truncation signal', () => {
    const data = { id: 1, text: 'X'.repeat(40000) }
    const { result, truncated } = smartTruncateJson(data, 2000)
    expect(truncated).toBe(true)

    const parsed = JSON.parse(result) // must remain valid JSON
    expect(parsed._truncation).toBeDefined()
    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed._truncation.omittedFields).toContain('text')
    // Must tell the agent how to recover the rest (fetch full / export / source).
    expect(String(parsed._truncation.hint ?? '')).toMatch(/full|fetch|export|source/i)
  })

  test('array slicing also carries the _truncation signal', () => {
    const data = { items: Array.from({ length: 5000 }, (_, i) => ({ i, v: 'y'.repeat(50) })) }
    const { result, truncated } = smartTruncateJson(data, 3000)
    expect(truncated).toBe(true)

    const parsed = JSON.parse(result)
    expect(parsed._truncation?.truncated).toBe(true)
  })
})
