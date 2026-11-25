// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { canonicalBaseline, parseTscOutput, regressions } from '../ci/api-typecheck-ratchet'

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

  test('src-vs-dist TS2322 in apps/api/src is excluded as build-environment noise', () => {
    // apps/api/src imports the SDK; CI hasn't pre-built it so tsc resolves to sdk/src.
    // The dev machine has sdk/dist. Same structure, different nominal identity → TS2322.
    // This must NOT count as a regression.
    const srcDistError =
      `${ROOT}/apps/api/src/lib/runtime/cloud-content-sync.ts(10,5): error TS2322: ` +
      `Type 'import("${ROOT}/packages/sdk/src/lib/file-transport").CloudFileTransport' ` +
      `is not assignable to type 'import("${ROOT}/packages/sdk/dist/lib/file-transport").CloudFileTransport'.`
    expect(parseTscOutput(srcDistError)).toEqual({})
  })

  test('a real TS2322 in apps/api/src (wrong shape, not src/dist) is still caught', () => {
    // A real shape mismatch does NOT involve packages/X/src vs packages/X/dist.
    const realTs2322 =
      `${ROOT}/apps/api/src/routes/grant.ts(5,3): error TS2322: ` +
      `Type 'string' is not assignable to type 'number'.`
    const counts = parseTscOutput(realTs2322)
    expect(Object.keys(counts)).toHaveLength(1)
    expect(Object.keys(counts)[0]).toContain('apps/api/src/routes/grant.ts')
  })

  test('only errors above the baseline count are regressions', () => {
    const baseline = { 'a TS1 x': 2, 'b TS2 y': 1 }
    expect(regressions(baseline, { 'a TS1 x': 2, 'b TS2 y': 0 })).toEqual([])
    expect(regressions(baseline, { 'a TS1 x': 3 })).toEqual(['+1  a TS1 x'])
    expect(regressions(baseline, { 'c TS3 new': 1 })).toEqual(['+1  c TS3 new'])
  })

  test('the same union printed in another order is not a regression', () => {
    // SHO-486: three new modules under apps/api/src/lib shifted the order tsc
    // created these string-literal types in, so a baselined error printed its
    // union differently and the ratchet called it new. Same error, two sites.
    const baseline = canonicalBaseline({
      "apps/api/src/services/app-install-grants.service.ts TS2345 Argument of type '404 | 503 | 412 | 502 | 409 | 400 | 403' is not assignable to parameter of type '404 | 503 | 502 | 409 | 400 | 403'.": 2,
    })
    const out = [
      `${ROOT}/apps/api/src/services/app-install-grants.service.ts(253,33): error TS2345: Argument of type '404 | 400 | 403 | 409 | 502 | 412 | 503' is not assignable to parameter of type '404 | 400 | 403 | 409 | 502 | 503'.`,
      `  Type '412' is not assignable to type '404 | 400 | 403 | 409 | 502 | 503'.`,
      `${ROOT}/apps/api/src/services/app-install-grants.service.ts(339,76): error TS2345: Argument of type '404 | 400 | 403 | 409 | 502 | 412 | 503' is not assignable to parameter of type '404 | 400 | 403 | 409 | 502 | 503'.`,
      `  Type '412' is not assignable to type '404 | 400 | 403 | 409 | 502 | 503'.`,
    ].join('\n')
    expect(regressions(baseline, parseTscOutput(out))).toEqual([])
  })

  test('rootDir (TS6059) and allowImportingTsExtensions (TS5097) are never counted', () => {
    // tsc names one importing file per out-of-rootDir target, whichever it
    // reaches first, so an unrelated file joining the program moves the error
    // to the other importer of the same target (SHO-486).
    const out = [
      `${ROOT}/apps/api/src/services/conversation-directory.ts(16,48): error TS6059: File '${ROOT}/packages/shared-app/src/buddy-look.ts' is not under 'rootDir' '${ROOT}/apps/api'.`,
      `${ROOT}/apps/api/src/services/conversation.service.ts(21,48): error TS6059: File '${ROOT}/packages/shared-app/src/buddy-look.ts' is not under 'rootDir' '${ROOT}/apps/api'.`,
      `${ROOT}/apps/api/src/routes/local-auth.ts(9,1): error TS5097: Option 'allowImportingTsExtensions' is set.`,
    ].join('\n')
    expect(parseTscOutput(out)).toEqual({})
    expect(canonicalBaseline({ 'apps/api/src/routes/local-auth.ts TS6059 File x.': 3 })).toEqual({})
  })
})
