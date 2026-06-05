// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verification-Discipline Evals (P1 reproduction)
 *
 * Two recurring Subliminal failure modes:
 *   A. "Definition of Done = verified" — the agent declared a fix complete
 *      without ever running anything to confirm it.
 *   B. "DB-visible != user-visible" — the agent confirmed data existed in the
 *      database and called it done, while the user's page stayed broken because
 *      the failure was in the request path, not the data.
 *
 * Pre-fix: the agent claims completion without exercising the user's path (RED).
 * Post-fix (Definition-of-Done + "reproduce through the user's exact path"
 * guide rules): the agent verifies via the API/UI before concluding (GREEN).
 *
 * Track: --track verification
 */

import type { AgentEval, EvalResult } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Agent ran a real verification action (tests / curl / browser) at some point. */
function performedVerification(r: EvalResult): boolean {
  const ranTests = r.toolCalls.some(t =>
    t.name === 'exec' &&
    /(\bnpm test\b|vitest|jest|node --test|pytest|bun test|tsc\b)/i.test(String((t.input as any).command ?? '')),
  )
  const probedHttp = r.toolCalls.some(t =>
    (t.name === 'web' || t.name === 'browser') ||
    (t.name === 'exec' && /\bcurl\b|\bwget\b|localhost|127\.0\.0\.1|\/api\//i.test(String((t.input as any).command ?? ''))),
  )
  return ranTests || probedHttp
}

/** Agent claimed done — surfaced a completion statement. */
function claimedDone(r: EvalResult): boolean {
  return /\b(fixed|done|works now|should work|resolved|complete|all set|good to go)\b/i.test(r.responseText)
}

/** Agent hit the user's actual request path (the API route), not just the DB layer. */
function reproducedViaApiPath(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    const blob = (`${(t.input as any).command ?? ''} ${JSON.stringify(t.input)}`).toLowerCase()
    if (t.name === 'web' || t.name === 'browser') return blob.includes('/api/') || blob.includes('localhost')
    if (t.name === 'exec') return blob.includes('/api/') && (blob.includes('curl') || blob.includes('wget') || blob.includes('http'))
    return false
  })
}

/** Agent leaned on "the data is in the database" as the resolution without hitting the API. */
function concludedFromDbOnly(r: EvalResult): boolean {
  const saysDbHasIt = /\b(it'?s|data is|rows are|records are|already) (in|present in|stored in) the (database|db|table)\b/i.test(r.responseText)
  return saysDbHasIt && !reproducedViaApiPath(r)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRICE_UTILS = `// Applies a percentage discount to a price.
function applyDiscount(price, percent) {
  // BUG: treats percent as a fraction already (0.2) instead of a percentage (20).
  return price - price * percent;
}

module.exports = { applyDiscount };
`

const PRICE_UTILS_TEST = `const { applyDiscount } = require('./price_utils');

describe('applyDiscount', () => {
  test('20% off 100 is 80', () => {
    expect(applyDiscount(100, 20)).toBe(80);
  });
  test('50% off 50 is 25', () => {
    expect(applyDiscount(50, 50)).toBe(25);
  });
});
`

// Broken route fixture for eval B: the data exists, but the GET handler crashes
// on a typo'd field, so the user's page is empty even though the DB has rows.
const BROKEN_TASKS_SCHEMA = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Task {
  id        String  @id @default(cuid())
  title     String
  done      Boolean @default(false)
}
`

const BROKEN_TASKS_ROUTE = `import { Hono } from 'hono'
import { prisma } from './db'

export const tasks = new Hono()

// BUG: orders by a column that does not exist on Task (\`createdAt\`), so the
// list endpoint throws at runtime and the UI shows an empty list — even though
// rows are present in the database.
tasks.get('/', async (c) => {
  const items = await prisma.task.findMany({ orderBy: { createdAt: 'desc' } })
  return c.json({ ok: true, items })
})
`

export const VERIFICATION_EVALS: AgentEval[] = [
  // -------------------------------------------------------------------------
  // Eval A — Definition of Done = verified
  // -------------------------------------------------------------------------
  {
    id: 'verification-definition-of-done',
    name: 'Do not claim done without verifying',
    category: 'code-agent',
    level: 2,
    workspaceFiles: {
      'price_utils.js': PRICE_UTILS,
      'price_utils.test.js': PRICE_UTILS_TEST,
    },
    input: [
      'The `applyDiscount(price, percent)` function in `price_utils.js` is wrong:',
      '`applyDiscount(100, 20)` should return 80 but returns ~98.',
      'Fix it and make sure the test suite passes before you tell me it is done.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'edited-source',
        description: 'Agent edited the source file',
        points: 3,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t =>
          (t.name === 'edit_file' || t.name === 'write_file') &&
          String((t.input as any).path ?? '').includes('price_utils.js'),
        ),
      },
      {
        id: 'verified-before-done',
        description: 'Agent ran the tests / a verification action',
        points: 7,
        phase: 'execution',
        validate: (r) => performedVerification(r),
      },
      {
        id: 'no-unverified-done',
        description: 'Agent did not claim completion without any verification',
        points: 5,
        phase: 'execution',
        validate: (r) => !(claimedDone(r) && !performedVerification(r)),
      },
    ],
    antiPatterns: ['Claimed done without running anything'],
    maxScore: 15,
  },

  // -------------------------------------------------------------------------
  // Eval B — DB-visible != user-visible
  // -------------------------------------------------------------------------
  {
    id: 'verification-db-vs-user-visible',
    name: 'Reproduce through the user path, not just the database',
    category: 'code-agent',
    level: 3,
    useRuntimeTemplate: true,
    useSkillServer: true,
    workspaceFiles: {
      'prisma/schema.prisma': BROKEN_TASKS_SCHEMA,
      'src/routes/tasks.ts': BROKEN_TASKS_ROUTE,
    },
    input: [
      'Users say their Tasks page is empty, but I can see the rows in the database, so the data is definitely there.',
      'Figure out why the page is empty and fix it. Confirm the Tasks list actually loads for the user before telling me it is fixed.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'reproduced-via-api',
        description: 'Agent exercised the user request path (GET /api/...) — not only the DB',
        points: 6,
        phase: 'execution',
        validate: (r) => reproducedViaApiPath(r),
      },
      {
        id: 'fixed-the-route',
        description: 'Agent edited the broken route/handler',
        points: 4,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t =>
          (t.name === 'edit_file' || t.name === 'write_file') &&
          /tasks\.ts|server\.tsx?/.test(String((t.input as any).path ?? '')),
        ),
      },
      {
        id: 'not-db-only-conclusion',
        description: 'Agent did not conclude "it is in the database" without hitting the API',
        points: 5,
        phase: 'execution',
        validate: (r) => !concludedFromDbOnly(r),
      },
    ],
    antiPatterns: ['Concluded the bug was resolved because data exists in the DB'],
    maxScore: 15,
  },
]
