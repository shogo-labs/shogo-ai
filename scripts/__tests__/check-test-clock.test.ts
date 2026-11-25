// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  evaluateTestClock,
  hasFrozenClock,
  pruneBaseline,
  scanDateLiterals,
  type TestClockBaseline,
} from '../check-test-clock'

const EMPTY: TestClockBaseline = { files: {}, allow: {} }

// The SHO-505 shape: seed a fixed day, then compare it against the real clock.
const BOMB = `
import { describe, expect, test } from 'bun:test'
describe('vm compute billing', () => {
  test('hosts reporting usage', async () => {
    await seedUsage({ runningSince: new Date('2026-11-18T00:00:00Z') })
    const summary = await adminComputeSummary()
    expect(summary.hostsReportingUsage).toBeGreaterThan(0)
  })
})
`

const PINNED = `
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
describe('vm compute billing', () => {
  beforeAll(() => setSystemTime(new Date('2026-11-18T12:00:00Z')))
  afterAll(() => setSystemTime(new Date()))
  test('hosts reporting usage', async () => {
    await seedUsage({ runningSince: new Date('2026-11-18T00:00:00Z') })
    expect(await adminComputeSummary()).toBeDefined()
  })
})
`

describe('check-test-clock', () => {
  test('an unpinned date literal in a new file is a regression', () => {
    const report = evaluateTestClock([{ file: 'apps/api/src/__tests__/bomb.test.ts', source: BOMB }], EMPTY)
    expect(report.regressions).toHaveLength(1)
    expect(report.regressions[0]).toContain('apps/api/src/__tests__/bomb.test.ts')
    expect(report.regressions[0]).toContain("new Date('2026-11-18")
    expect(report.stale).toHaveLength(0)
  })

  test('the same file with the clock pinned next to the seed passes', () => {
    const report = evaluateTestClock([{ file: 'apps/api/src/__tests__/bomb.test.ts', source: PINNED }], EMPTY)
    expect(report.regressions).toHaveLength(0)
    expect(report.stale).toHaveLength(0)
    expect(hasFrozenClock(PINNED)).toBe(true)
    expect(hasFrozenClock(BOMB)).toBe(false)
  })

  test('a format-only file is allowed and recorded in the allow map', () => {
    const source = `// test-clock: format-only\n${BOMB}`
    const report = evaluateTestClock([{ file: 'apps/api/src/lib/__tests__/format.test.ts', source }], EMPTY)
    expect(report.regressions).toHaveLength(0)
    expect(pruneBaseline([{ file: 'apps/api/src/lib/__tests__/format.test.ts', source }], EMPTY)).toEqual({
      files: {},
      allow: { 'apps/api/src/lib/__tests__/format.test.ts': 'format-only' },
    })
  })

  test('a baselined file at the same count passes, one literal more fails', () => {
    const file = 'apps/api/src/__tests__/bomb.test.ts'
    const baseline: TestClockBaseline = { files: { [file]: 1 }, allow: {} }
    const grown = BOMB.replace("expect(summary.hostsReportingUsage).toBeGreaterThan(0)", 'expect(Date.UTC(2026, 10, 18)).toBeGreaterThan(0)')
    expect(scanDateLiterals(grown)).toHaveLength(2)

    expect(evaluateTestClock([{ file, source: BOMB }], baseline).regressions).toHaveLength(0)
    const report = evaluateTestClock([{ file, source: grown }], baseline)
    expect(report.regressions).toHaveLength(1)
    expect(report.regressions[0]).toContain('(+1 vs baseline)')
  })

  test('a baselined file that was fixed is stale, so the list can only shrink', () => {
    const file = 'apps/api/src/__tests__/bomb.test.ts'
    const report = evaluateTestClock([{ file, source: PINNED }], { files: { [file]: 1 }, allow: {} })
    expect(report.regressions).toHaveLength(0)
    expect(report.stale).toEqual([file])
  })

  test('an allow entry for a file with no literals left is stale', () => {
    const file = 'apps/api/src/lib/__tests__/format.test.ts'
    const report = evaluateTestClock([{ file, source: 'test("x", () => {})' }], { files: {}, allow: { [file]: 'format-only' } })
    expect(report.staleAllow).toEqual([file])
  })

  test('recognises year-first literals only', () => {
    const source = [
      "const a = new Date('2026-11-18T00:00:00Z')",
      'const b = new Date(2026, 10, 18)',
      'const c = Date.UTC(2026, 10, 18)',
      "const d = Date.parse('2026-11-18')",
      'const e = new Date(0)',
      'const f = new Date(86_400_000)',
      "const g = new Date('11/18/2026')",
    ].join('\n')
    const findings = scanDateLiterals(source)
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4])
  })

  test('pruneBaseline keeps the current offenders and drops the rest', () => {
    const baseline = pruneBaseline(
      [
        { file: 'a.test.ts', source: BOMB },
        { file: 'b.test.ts', source: PINNED },
      ],
      { files: { 'b.test.ts': 3, 'gone.test.ts': 1 }, allow: {} },
    )
    expect(baseline).toEqual({ files: { 'a.test.ts': 1 }, allow: {} })
  })
})
