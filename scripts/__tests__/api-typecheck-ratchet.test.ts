// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { parseTscOutput, regressions } from '../ci/api-typecheck-ratchet'

const ROOT = resolve(import.meta.dir, '..', '..')

describe('api-typecheck-ratchet', () => {
  test('keys errors by repo-relative file + code + message, ignoring line/column', () => {
    const out = [
      `src/services/a.ts(10,5): error TS2353: Object literal may only specify known properties, and 'signupRiskAssessment' does not exist in type 'UserWhereInput'.`,
      `src/services/a.ts(99,1): error TS2353: Object literal may only specify known properties, and 'signupRiskAssessment' does not exist in type 'UserWhereInput'.`,
      // packages/* errors are excluded from counting — environment-specific resolution noise
      `${ROOT}/packages/email/src/server.ts(41,8): error TS6059: File '${ROOT}/packages/email/src/types.ts' is not under 'rootDir'.`,
      `  continuation line that tsc indents`,
      `Found 3 errors.`,
    ].join('\n')
    // Only apps/api/src errors are counted; packages/* is excluded (see ratchet script).
    expect(parseTscOutput(out)).toEqual({
      "apps/api/src/services/a.ts TS2353 Object literal may only specify known properties, and 'signupRiskAssessment' does not exist in type 'UserWhereInput'.": 2,
    })
  })

  test('catches the outage class: invalid Prisma relation in apps/api/src is a regression', () => {
    // This mirrors exactly what tsc emits when the outage query ships:
    //   prisma.user.count({ where: { signupRiskAssessment: { ... } } })
    // The relation does not exist on User; tsc flags it as TS2353.
    // tsc always emits absolute paths; simulate that.
    const outageError =
      `${ROOT}/apps/api/src/services/signup-risk.service.ts(42,5): error TS2353: ` +
      `Object literal may only specify known properties, and 'signupRiskAssessment' does not exist in type 'UserWhereInput'.`
    const counts = parseTscOutput(outageError)
    // With an empty baseline (no known debt for this key) it must be a regression.
    const found = regressions({}, counts)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('signupRiskAssessment')
    expect(found[0]).toContain('apps/api/src/services/signup-risk.service.ts')
  })

  test('only errors above the baseline count are regressions', () => {
    const baseline = { 'a TS1 x': 2, 'b TS2 y': 1 }
    expect(regressions(baseline, { 'a TS1 x': 2, 'b TS2 y': 0 })).toEqual([])
    expect(regressions(baseline, { 'a TS1 x': 3 })).toEqual(['+1  a TS1 x'])
    expect(regressions(baseline, { 'c TS3 new': 1 })).toEqual(['+1  c TS3 new'])
  })
})
