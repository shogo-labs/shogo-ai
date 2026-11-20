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
      `${ROOT}/packages/email/src/server.ts(41,8): error TS6059: File '${ROOT}/packages/email/src/types.ts' is not under 'rootDir'.`,
      `  continuation line that tsc indents`,
      `Found 3 errors.`,
    ].join('\n')
    expect(parseTscOutput(out)).toEqual({
      "apps/api/src/services/a.ts TS2353 Object literal may only specify known properties, and 'signupRiskAssessment' does not exist in type 'UserWhereInput'.": 2,
      "packages/email/src/server.ts TS6059 File '<repo>/packages/email/src/types.ts' is not under 'rootDir'.": 1,
    })
  })

  test('only errors above the baseline count are regressions', () => {
    const baseline = { 'a TS1 x': 2, 'b TS2 y': 1 }
    expect(regressions(baseline, { 'a TS1 x': 2, 'b TS2 y': 0 })).toEqual([])
    expect(regressions(baseline, { 'a TS1 x': 3 })).toEqual(['+1  a TS1 x'])
    expect(regressions(baseline, { 'c TS3 new': 1 })).toEqual(['+1  c TS3 new'])
  })
})
