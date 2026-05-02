// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  formatTime,
  LEVEL_COLORS,
  LEVEL_FILTERS,
  parseLogLine,
  resetParserIdsForTest,
  stripAnsi,
} from '../log-utils'

beforeEach(() => {
  resetParserIdsForTest()
})

describe('stripAnsi', () => {
  test('removes CSI color codes', () => {
    expect(stripAnsi('\x1B[31merror\x1B[0m')).toBe('error')
  })

  test('removes nested escape sequences', () => {
    expect(stripAnsi('\x1B[1;33m[warn]\x1B[0m hello')).toBe('[warn] hello')
  })

  test('passes through plain text untouched', () => {
    expect(stripAnsi('plain log line')).toBe('plain log line')
  })

  test('handles \\x9B+[ form of CSI', () => {
    // The current regex requires `[` after the CSI introducer (consistent
    // with most terminal emulators that emit `ESC [` even in 8-bit mode).
    expect(stripAnsi('\x9B[31mboom\x9B[0m')).toBe('boom')
  })
})

describe('parseLogLine — id assignment', () => {
  test('ids are monotonically increasing', () => {
    const a = parseLogLine('hello')
    const b = parseLogLine('world')
    expect(b.id).toBe(a.id + 1)
  })

  test('resetParserIdsForTest restarts the counter', () => {
    parseLogLine('first')
    parseLogLine('second')
    resetParserIdsForTest()
    const fresh = parseLogLine('after-reset')
    expect(fresh.id).toBe(0)
  })
})

describe('parseLogLine — timestamp peeling', () => {
  test('peels a leading bracketed ISO timestamp and tags source=agent', () => {
    const e = parseLogLine('[2025-04-12T10:11:12.345Z] startup complete')
    expect(e.ts).toBe('2025-04-12T10:11:12.345Z')
    expect(e.source).toBe('agent')
    expect(e.message).toBe('startup complete')
  })

  test('peels a leading 12h timestamp', () => {
    const e = parseLogLine('1:02:03 PM something')
    expect(e.ts).toBe('1:02:03 PM')
    expect(e.source).toBe('agent')
    expect(e.message).toBe('something')
  })

  test('peels a leading 24h timestamp', () => {
    const e = parseLogLine('13:14:15 something')
    expect(e.ts).toBe('13:14:15')
    expect(e.source).toBe('agent')
    expect(e.message).toBe('something')
  })

  test('preserves the raw line even after stripping', () => {
    const raw = '\x1B[36m[2025-01-01T00:00:00Z]\x1B[0m hello'
    const e = parseLogLine(raw)
    expect(e.raw).toBe(raw)
    expect(e.message).toBe('hello')
  })

  test('without a recognized timestamp keeps source=system and ts=null', () => {
    const e = parseLogLine('no timestamp here')
    expect(e.ts).toBeNull()
    expect(e.source).toBe('system')
    expect(e.message).toBe('no timestamp here')
  })
})

describe('parseLogLine — bundler prefix peeling', () => {
  test('[vite] tag flips source to vite', () => {
    const e = parseLogLine('[vite] page reloaded')
    expect(e.source).toBe('vite')
    expect(e.message).toBe('page reloaded')
  })

  test('[expo] tag flips source to vite (bundler bucket)', () => {
    // We use a single LogSource value 'vite' for all bundler tags so the
    // existing UI doesn't grow a new badge category. Pin that contract here.
    const e = parseLogLine('[expo] tunnel ready')
    expect(e.source).toBe('vite')
    expect(e.message).toBe('tunnel ready')
  })

  test('[metro] tag flips source to vite (bundler bucket)', () => {
    const e = parseLogLine('[metro] bundle 99% complete')
    expect(e.source).toBe('vite')
    expect(e.message).toBe('bundle 99% complete')
  })

  test('bundler tag is matched case-insensitively', () => {
    expect(parseLogLine('[VITE] foo').source).toBe('vite')
  })

  test('non-bundler bracketed prefix is NOT peeled', () => {
    const e = parseLogLine('[server] up')
    // `system` (no timestamp, no bundler tag) — the [server] prefix
    // stays on the message.
    expect(e.source).toBe('system')
    expect(e.message).toBe('[server] up')
  })

  test('bundler tag is peeled AFTER timestamp', () => {
    const e = parseLogLine('13:14:15 [vite] hmr')
    expect(e.ts).toBe('13:14:15')
    expect(e.source).toBe('vite')
    expect(e.message).toBe('hmr')
  })
})

describe('parseLogLine — level classification', () => {
  test('matches \\bERROR\\b at word boundary', () => {
    expect(parseLogLine('ERROR: missing file').level).toBe('error')
    expect(parseLogLine('thrown ERROR here').level).toBe('error')
  })

  test('matches \\bERR\\b at word boundary', () => {
    expect(parseLogLine('npm ERR! missing dep').level).toBe('error')
  })

  test('does NOT match "error" inside a longer word', () => {
    expect(parseLogLine('terror').level).toBe('info')
    expect(parseLogLine('mirroring').level).toBe('info')
  })

  test('matches \\bWARN\\b at word boundary', () => {
    expect(parseLogLine('WARN: deprecated API').level).toBe('warn')
  })

  test('does NOT downgrade WARN when ERROR is also present (error wins)', () => {
    expect(parseLogLine('ERROR after a WARN').level).toBe('error')
  })

  test('classification is case-sensitive (lowercase "error" → info)', () => {
    // The current heuristic is uppercase-only so we don't over-match
    // arbitrary user code that happens to mention "error" descriptively.
    expect(parseLogLine('error').level).toBe('info')
  })

  test('strips ANSI before classifying', () => {
    expect(parseLogLine('\x1B[31mERROR\x1B[0m: red').level).toBe('error')
  })

  test('default level is info', () => {
    expect(parseLogLine('hello world').level).toBe('info')
  })
})

describe('formatTime', () => {
  test('null → empty string', () => {
    expect(formatTime(null)).toBe('')
  })

  test('returns 12h string unchanged', () => {
    expect(formatTime('1:02:03 PM')).toBe('1:02:03 PM')
    expect(formatTime('11:59:59 AM')).toBe('11:59:59 AM')
  })

  test('converts 24h to 12h', () => {
    expect(formatTime('13:14:15')).toBe('1:14:15 PM')
    expect(formatTime('00:00:00')).toBe('12:00:00 AM')
    expect(formatTime('12:00:00')).toBe('12:00:00 PM')
    expect(formatTime('23:59:59')).toBe('11:59:59 PM')
  })

  test('valid ISO timestamp goes through Date#toLocaleTimeString', () => {
    const out = formatTime('2025-04-12T13:14:15Z')
    // Format depends on host locale, but we can assert it's not empty
    // and not the raw input.
    expect(out).toBeTruthy()
    expect(out).not.toBe('2025-04-12T13:14:15Z')
  })

  test('garbage input falls through to itself rather than throwing', () => {
    expect(formatTime('not a date')).toBe('not a date')
    expect(formatTime('')).toBe('')
  })
})

describe('LEVEL_FILTERS / LEVEL_COLORS contract', () => {
  test('filters list is exactly all/error/warn/info', () => {
    expect(LEVEL_FILTERS).toEqual(['all', 'error', 'warn', 'info'])
  })

  test('colors map covers every level', () => {
    expect(LEVEL_COLORS.error).toBeTruthy()
    expect(LEVEL_COLORS.warn).toBeTruthy()
    expect(LEVEL_COLORS.info).toBeTruthy()
  })
})
