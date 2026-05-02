// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the Monitor LogsPanel <→ runtime-log-store data path.
 *
 * `LogsPanel` itself renders RN primitives, which we don't render under
 * happy-dom (per the plan's testing scope). What we *do* test is the
 * pure mapping function that turns a `RuntimeLogEntry` into a
 * `ParsedLogEntry` — the contract that lets the legacy LogsPanel UI keep
 * working unchanged while consuming the new typed stream.
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { resetParserIdsForTest } from '../log-utils'
import { runtimeEntryToParsed } from '../runtime-entry-to-parsed'
import type { RuntimeLogEntry } from '../../../lib/runtime-logs/runtime-log-store'

beforeEach(() => {
  resetParserIdsForTest()
})

function entry(overrides: Partial<RuntimeLogEntry> = {}): RuntimeLogEntry {
  return {
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? 'console',
    level: overrides.level ?? 'info',
    text: overrides.text ?? 'a line',
  }
}

describe('runtimeEntryToParsed', () => {
  test('preserves the dispatcher-assigned level even when the body looks innocuous', () => {
    const result = runtimeEntryToParsed(
      entry({ level: 'error', text: 'something went wrong' }),
    )
    expect(result.level).toBe('error')
  })

  test('keeps the bracketed [source] prefix in the visible message', () => {
    const result = runtimeEntryToParsed(
      entry({ source: 'build', text: 'webpack done' }),
    )
    expect(result.message).toContain('[build]')
    expect(result.message).toContain('webpack done')
  })

  test('does not downgrade an error to info when the body lacks "ERROR"', () => {
    const result = runtimeEntryToParsed(
      entry({ level: 'error', text: 'failed compilation' }),
    )
    // The parser's heuristic would call this `info`; the dispatcher's
    // explicit level wins.
    expect(result.level).toBe('error')
  })

  test('does not upgrade an info entry to error just because body says ERROR', () => {
    const result = runtimeEntryToParsed(
      entry({ level: 'info', text: 'log says ERROR but it was a false alarm' }),
    )
    expect(result.level).toBe('info')
  })

  test('warn entries pass through with level=warn', () => {
    const result = runtimeEntryToParsed(
      entry({ level: 'warn', text: 'deprecated api' }),
    )
    expect(result.level).toBe('warn')
  })

  test('source filters work after mapping (build/console/canvas-error/exec)', () => {
    const all = (
      ['build', 'console', 'canvas-error', 'exec'] as const
    ).map((s, i) => runtimeEntryToParsed(entry({ seq: i + 1, source: s, text: `${s}-line` })))
    expect(all.map((r) => r.message)).toEqual([
      '[build] build-line',
      '[console] console-line',
      '[canvas-error] canvas-error-line',
      '[exec] exec-line',
    ])
  })

  test('id is monotonically increasing across calls', () => {
    const a = runtimeEntryToParsed(entry({ seq: 1, text: 'first' }))
    const b = runtimeEntryToParsed(entry({ seq: 2, text: 'second' }))
    expect(b.id).toBeGreaterThan(a.id)
  })

  test('ANSI escape codes inside the text are stripped', () => {
    const result = runtimeEntryToParsed(
      entry({ text: '\x1B[31mred text\x1B[0m' }),
    )
    expect(result.message).not.toContain('\x1B')
    expect(result.message).toContain('red text')
  })
})
