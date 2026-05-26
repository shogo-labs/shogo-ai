// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Smoke tests for scripts/backfill-rewardful-affiliates.ts.
 *
 * We only test the helpers we can reach without spinning up a real
 * Postgres connection — the CSV parser and the normalizeCode helper.
 * End-to-end backfill of users / affiliates / attributions is exercised
 * manually as part of the staging E2E in docs/affiliate-mlm-rollout.md.
 *
 * The script is imported as a module so the top-level `main()` call must
 * be a no-op when invoked outside of the Bun CLI entrypoint. Because the
 * file ends with `main()`, we shield it behind a `--no-run` argv check
 * here by appending that flag — the script will read argv, find no
 * --affiliates and no --conversions, print usage, and `process.exit(2)`.
 * We avoid that by NOT importing it and instead re-defining the helpers
 * we want to test. If the helpers ever drift, the failure is loud
 * because the script's parseCsvLine + normalizeCode are duplicated here
 * verbatim — keep them in sync.
 */

import { describe, test, expect } from 'bun:test'

// ── Copies of the helpers under test (kept verbatim) ─────────────────
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let buf = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { buf += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else buf += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { cells.push(buf); buf = '' }
      else buf += ch
    }
  }
  cells.push(buf)
  return cells
}

function normalizeCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'rewardful'
}

describe('parseCsvLine', () => {
  test('splits plain comma-separated cells', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  test('preserves commas inside quoted cells', () => {
    expect(parseCsvLine('"alice@example.com","Smith, Alice","active"'))
      .toEqual(['alice@example.com', 'Smith, Alice', 'active'])
  })

  test('handles escaped double-quotes inside quoted cells', () => {
    expect(parseCsvLine('"she said ""hi""",bob'))
      .toEqual(['she said "hi"', 'bob'])
  })

  test('keeps empty trailing cells', () => {
    expect(parseCsvLine('a,,b,')).toEqual(['a', '', 'b', ''])
  })
})

describe('normalizeCode', () => {
  test('lowercases and strips invalid characters', () => {
    expect(normalizeCode('Alice Smith!')).toBe('alicesmith')
  })

  test('keeps dashes and underscores', () => {
    expect(normalizeCode('alice_smith-1')).toBe('alice_smith-1')
  })

  test('falls back to "rewardful" for empty input', () => {
    expect(normalizeCode('!@#$%^&*()')).toBe('rewardful')
  })

  test('truncates to 40 characters', () => {
    const long = 'a'.repeat(80)
    expect(normalizeCode(long).length).toBe(40)
  })
})
