// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Long-Task / Iteration-Ceiling Evals (P1 reproduction)
 *
 * Reproduces the Subliminal regression where a long task hit the agent's
 * per-turn iteration ceiling and the turn ended with an EMPTY assistant
 * message — the user got silence instead of a summary or a handoff.
 *
 * Run with a low ceiling so the cap is hit quickly and deterministically:
 *   EVAL_AGENT_MAX_ITERATIONS=6 \
 *     bun run src/evals/run-eval.ts --track long-task --vm --workers 1
 *
 * The runner threads EVAL_AGENT_MAX_ITERATIONS → AGENT_MAX_ITERATIONS inside
 * the VM (see run-eval.ts vmWorkerConfig.envOverrides), and the harness now
 * captures hitMaxTurns / responseEmpty from the gateway's data-usage frame.
 *
 * Pre-fix: hitting the ceiling yields an empty final message (RED). Post-fix
 * (main-agent auto-continue + guaranteed non-empty summary on the ceiling):
 * the final message is non-empty and acknowledges the handoff (GREEN).
 *
 * Track: --track long-task
 */

import type { AgentEval, EvalResult } from './types'
import { hitMaxTurns, responseWasEmpty } from './eval-helpers'

function madeSomeProgress(r: EvalResult): boolean {
  return r.toolCalls.some(t => t.name === 'write_file' || t.name === 'edit_file')
}

/** If the ceiling was hit, the final message must acknowledge incomplete work / a handoff. */
function acknowledgedHandoffIfCeiling(r: EvalResult): boolean {
  if (!hitMaxTurns(r)) return true
  return /(remaining|still (need|to do)|next step|did not finish|didn'?t finish|ran out|out of (turns|iterations)|continue|hand ?off|so far|completed so far|where i left off|to be continued)/i
    .test(r.responseText)
}

export const LONG_TASK_EVALS: AgentEval[] = [
  {
    id: 'long-task-iteration-ceiling-summary',
    name: 'Hitting the iteration ceiling must not produce an empty turn',
    category: 'code-agent',
    level: 4,
    useRuntimeTemplate: true,
    useSkillServer: true,
    input: [
      'Build a small CRM in this app. I want three models with full REST CRUD routes and a dashboard:',
      '  1. Contact (name, email, phone)',
      '  2. Company (name, domain, industry)',
      '  3. Deal (title, amountCents, stage, contactId, companyId)',
      'Then add a dashboard page that lists all three with create forms, wire it to the API,',
      'and seed a few example rows for each. Build it incrementally and keep me posted on progress.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'non-empty-final-message',
        description: 'Final assistant message is NOT empty (even when the ceiling is hit)',
        points: 7,
        phase: 'execution',
        validate: (r) => !responseWasEmpty(r),
      },
      {
        id: 'acknowledged-handoff',
        description: 'If the ceiling was hit, the agent summarized progress / remaining work',
        points: 5,
        phase: 'execution',
        validate: (r) => acknowledgedHandoffIfCeiling(r),
      },
      {
        id: 'made-progress',
        description: 'Agent actually produced files before the ceiling',
        points: 3,
        phase: 'execution',
        validate: (r) => madeSomeProgress(r),
      },
    ],
    antiPatterns: ['Empty final message after exhausting iterations'],
    maxScore: 15,
  },
]
