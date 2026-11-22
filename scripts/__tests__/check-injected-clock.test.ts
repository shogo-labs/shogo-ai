// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  collectInjectedClockReads,
  evaluateInjectedClock,
  findInjectedClockReads,
} from '../check-injected-clock'

// The SHO-505 bug, reduced: the caller passes a fixed date, delegates to a
// helper that reads the wall clock, and the assertion is about the interval
// between them. `reconcile()` takes no clock at all — nothing inside it looks
// wrong, which is why the leak survived review.
const OLD_COMPUTE_USAGE = `
export async function reconcile() {
  const since = new Date(Date.now() - 72 * 3600_000)
  return prisma.usageEvent.findMany({ where: { createdAt: { gte: since } } })
}

export async function adminComputeSummary({ now }: { now: Date }) {
  const { hostsReportingUsage } = await reconcile()
  return { hostsReportingUsage, windowStart: now }
}
`

const FIXED = `
export async function reconcile(now: Date) {
  const since = new Date(now.getTime() - 72 * 3600_000)
  return prisma.usageEvent.findMany({ where: { createdAt: { gte: since } } })
}

export async function adminComputeSummary({ now }: { now: Date }) {
  const { hostsReportingUsage } = await reconcile(now)
  return { hostsReportingUsage }
}
`

describe('findInjectedClockReads', () => {
  test('flags Date.now() inside a function handed `now`', () => {
    const findings = findInjectedClockReads(
      `export function window(now: Date) { return { since: Date.now() - 10 } }`,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'Date.now()', owner: 'window', line: 1 })
  })

  test('flags argument-less new Date() inside a destructured-options function', () => {
    const findings = findInjectedClockReads(
      `export function summary({ now }: { now: Date }) { const at = new Date(); return at }`,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('new Date()')
  })

  test('the injected value is clean, and an explicit-argument new Date() is not a live read', () => {
    expect(
      findInjectedClockReads(
        `export function window(now: Date) { return { since: now.getTime() - 10, at: new Date(0) } }`,
      ),
    ).toEqual([])
  })

  test('a live read outside an injected function is not this rule', () => {
    expect(findInjectedClockReads(`export function health() { return { at: Date.now() } }`)).toEqual([])
  })

  test('the `now` parameter default is the seam, not a leak', () => {
    expect(
      findInjectedClockReads(`export function window(now: Date = new Date()) { return now.getTime() }`),
    ).toEqual([])
  })

  test('`// injected-clock: live <reason>` on the line above takes the read out', () => {
    const findings = findInjectedClockReads(
      [
        'export function reconcile({ now }: { now: Date }) {',
        '  // injected-clock: live runningSinceMs is a monotonic start time, not the billing window',
        '  const startedAt = Date.now()',
        '  return billingWindow(now, startedAt)',
        '}',
      ].join('\n'),
    )
    expect(findings).toEqual([])
  })

  test('a bare escape comment without a reason does not silence a read', () => {
    const findings = findInjectedClockReads(
      ['export function w({ now }: { now: Date }) {', '  // injected-clock: live', '  return Date.now()', '}'].join(
        '\n',
      ),
    )
    expect(findings).toHaveLength(1)
  })

  test('catches the pre-SHO-505 compute-usage shape, one call away', () => {
    const findings = findInjectedClockReads(OLD_COMPUTE_USAGE, 'compute-usage.ts')
    // reconcile's own read, plus the same read reached from adminComputeSummary.
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings.every((finding) => finding.kind === 'Date.now()')).toBe(true)
    expect(findings.some((finding) => finding.owner.includes('adminComputeSummary'))).toBe(true)
  })

  test('the SHO-505 fix is clean', () => {
    expect(findInjectedClockReads(FIXED, 'compute-usage.ts')).toEqual([])
  })
})

describe('evaluateInjectedClock', () => {
  const key = 'apps/api/src/jobs/x.ts new Date()'

  test('a baselined read at the same count passes', () => {
    expect(evaluateInjectedClock({ [key]: 2 }, { [key]: 2 })).toEqual({ regressions: [], stale: [] })
  })

  test('a new read, or one more than the baseline, is a regression', () => {
    const report = evaluateInjectedClock({ [key]: 2, 'apps/api/src/jobs/y.ts Date.now()': 1 }, { [key]: 2 })
    expect(report.regressions).toEqual(['+1  apps/api/src/jobs/y.ts Date.now()'])
    expect(evaluateInjectedClock({ [key]: 3 }, { [key]: 2 }).regressions).toEqual([`+1  ${key}`])
  })

  test('a baselined read that was fixed is stale, so the list only shrinks', () => {
    expect(evaluateInjectedClock({}, { [key]: 1 }).stale).toEqual([key])
  })
})

describe('collectInjectedClockReads', () => {
  test('keys the baseline by file and read kind, not by line', () => {
    const counts = collectInjectedClockReads([
      { file: 'apps/api/src/a.ts', source: OLD_COMPUTE_USAGE },
      { file: 'apps/api/src/b.ts', source: FIXED },
    ])
    expect(counts).toEqual({ 'apps/api/src/a.ts Date.now()': 1 })
  })
})
