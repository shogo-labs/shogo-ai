// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Test-Hygiene Evals (P1 reproduction)
 *
 * Reproduces the Subliminal regressions where the agent's own tests left
 * residual rows in the live database (no/teardown swallowed), and where tests
 * hit paid external providers for real.
 *
 * The `expect-no-residual` tag makes the runtime check assert the agent left
 * zero rows behind (residualRecordCount === 0). The behavioral criteria check
 * the test code itself: real awaited teardown, no swallowed cleanup errors, and
 * no live paid-API calls.
 *
 * Pre-fix: no safe test scaffold / guidance → residue and/or paid calls (RED).
 * Post-fix (safe transactional test scaffold in templates/runtime-template +
 * "mock paid providers by default / protect demo entities" guide): clean (GREEN).
 *
 * Track: --track test-hygiene
 */

import type { AgentEval, EvalResult } from './types'

function testFileContents(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' && /\.(test|spec)\.[tj]sx?$/.test(String((t.input as any).path ?? '')))
    .map(t => String((t.input as any).content ?? ''))
    .join('\n\n')
}

function wroteTest(r: EvalResult): boolean {
  return testFileContents(r).length > 0
}

function hasAwaitedTeardown(r: EvalResult): boolean {
  const c = testFileContents(r)
  const hasHook = /\bafter(Each|All)\b|\bfinally\b|\$transaction\b/.test(c)
  const hasDelete = /delete(Many)?\s*\(|\bDELETE\b|\$transaction\b|rollback/i.test(c)
  return hasHook && hasDelete
}

/** Empty catch block around cleanup = swallowed teardown failure. */
function swallowedTeardown(r: EvalResult): boolean {
  const c = testFileContents(r)
  return /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(c) || /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(c)
}

/** Agent called a live paid provider (test should mock these). */
function calledPaidApi(r: EvalResult): boolean {
  const PAID = ['api.openai.com', 'api.anthropic.com', 'api.stripe.com', 'openrouter.ai', 'api.twilio.com', 'api.sendgrid.com']
  return r.toolCalls.some(t => {
    if (t.name !== 'exec' && t.name !== 'web') return false
    const blob = JSON.stringify(t.input).toLowerCase()
    return PAID.some(host => blob.includes(host))
  })
}

export const TEST_HYGIENE_EVALS: AgentEval[] = [
  {
    id: 'test-hygiene-no-residue-no-paid-api',
    name: 'Tests clean up after themselves and mock paid providers',
    category: 'code-agent',
    level: 3,
    useRuntimeTemplate: true,
    useSkillServer: true,
    tags: ['expect-no-residual'],
    input: [
      'Add a `Widget` model (name, sku) with a REST route.',
      'Then write and RUN an integration test that creates a Widget, asserts it shows up in the list,',
      'and removes it again so nothing is left behind. The test must clean up its own data even if an',
      'assertion fails. Do not call any paid external APIs in the test — mock them.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'wrote-a-test',
        description: 'Agent wrote a test file',
        points: 2,
        phase: 'execution',
        validate: (r) => wroteTest(r),
      },
      {
        id: 'awaited-teardown',
        description: 'Test has real teardown (afterEach/afterAll/finally/$transaction + delete)',
        points: 5,
        phase: 'execution',
        validate: (r) => hasAwaitedTeardown(r),
      },
      {
        id: 'no-swallowed-teardown',
        description: 'Cleanup errors are not swallowed by an empty catch',
        points: 3,
        phase: 'execution',
        validate: (r) => !swallowedTeardown(r),
      },
      {
        id: 'no-paid-api-calls',
        description: 'Test does not hit a live paid provider',
        points: 3,
        phase: 'execution',
        validate: (r) => !calledPaidApi(r),
      },
    ],
    antiPatterns: [
      'Left residual rows in the database',
      'Called a live paid API from a test',
    ],
    maxScore: 13,
  },
]
