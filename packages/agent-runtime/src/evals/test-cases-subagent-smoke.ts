// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Subagent capability smoke evals.
 *
 * Three tiny scenarios that decide whether a model can drive the
 * subagent loop end-to-end: spawn a child, await its result, and use
 * that result in the final answer. Drives the
 * `capabilities.subagentOrchestration` rating in the model catalog.
 *
 * Failure modes seen in real eval runs (e.g. MiMo-v2.5 via OpenRouter):
 *   - emits `agent_spawn` and stops (never calls `agent_result`)
 *   - calls `agent_create` but never spawns the resulting agent
 *   - spawns parallel children but synthesizes only one
 *
 * Each scenario is intentionally small (one or two seed files) so the
 * suite finishes in a couple of minutes and is cheap to re-run when
 * grading new OpenRouter / BYOK models.
 *
 * Run with:
 *   bun run packages/agent-runtime/src/evals/run-eval.ts \
 *     --track subagent-smoke --model <id> --workers 4
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callsByName(result: EvalResult, name: string): ToolCallRecord[] {
  return result.toolCalls.filter(tc => tc.name === name)
}

function spawnCount(result: EvalResult): number {
  return callsByName(result, 'task').length
    + callsByName(result, 'agent_spawn').length
}

function awaitedAtLeastOneResult(result: EvalResult): boolean {
  return callsByName(result, 'agent_result').length > 0
    || callsByName(result, 'task_result').length > 0
}

function spawnedAndAwaited(result: EvalResult): boolean {
  // The core orchestration check: at least one spawn AND at least one
  // result fetch. Models that fail this never finish multi-agent flows.
  return spawnCount(result) >= 1 && awaitedAtLeastOneResult(result)
}

// ---------------------------------------------------------------------------
// Smoke scenarios
// ---------------------------------------------------------------------------

const TINY_README = [
  '# Tiny Project',
  '',
  'A minimal TypeScript service.',
  '',
  '## Setup',
  '',
  '```bash',
  'pnpm install',
  'pnpm dev',
  '```',
].join('\n')

export const SUBAGENT_SMOKE_EVALS: AgentEval[] = [
  // -------------------------------------------------------------------------
  // Smoke 1: spawn-and-wait roundtrip
  // -------------------------------------------------------------------------
  {
    id: 'subagent-smoke-spawn-await',
    name: 'Spawns a subagent and waits for its result',
    category: 'subagent',
    level: 1,
    input:
      'Use a subagent to read README.md and tell me the two commands listed under Setup. ' +
      'Wait for the subagent to finish before answering — your final reply must contain both commands.',
    workspaceFiles: { 'README.md': TINY_README },
    validationCriteria: [
      {
        id: 'spawned-subagent',
        description: 'Agent emitted at least one agent_spawn / task call',
        points: 3,
        phase: 'intention',
        validate: (r) => spawnCount(r) >= 1,
      },
      {
        id: 'awaited-result',
        description: 'Agent fetched the subagent result before answering',
        points: 4,
        phase: 'intention',
        validate: (r) => awaitedAtLeastOneResult(r),
      },
      {
        id: 'spawn-and-await-pair',
        description: 'Agent both spawned a child and awaited its result (full roundtrip)',
        points: 3,
        phase: 'intention',
        validate: spawnedAndAwaited,
      },
      {
        id: 'returned-commands',
        description: 'Final response contains both setup commands',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          r.responseText.includes('pnpm install')
          && r.responseText.includes('pnpm dev'),
      },
    ],
    maxScore: 13,
  },

  // -------------------------------------------------------------------------
  // Smoke 2: agent_create + spawn + synthesis
  // -------------------------------------------------------------------------
  {
    id: 'subagent-smoke-create-and-use',
    name: 'Creates a custom specialist and uses it',
    category: 'subagent',
    level: 2,
    input:
      'Define a custom subagent named "lint-checker" whose job is to spot console.log calls in TS files. ' +
      'Then use it to check src/handler.ts and tell me whether it found any. ' +
      'You MUST: (1) call agent_create, (2) spawn that agent, and (3) wait for its result before answering.',
    workspaceFiles: {
      'src/handler.ts': [
        'export function handler(input: unknown) {',
        '  console.log("got input", input)',
        '  return { ok: true }',
        '}',
      ].join('\n'),
    },
    validationCriteria: [
      {
        id: 'created-agent',
        description: 'Agent called agent_create to define the lint-checker',
        points: 3,
        phase: 'intention',
        validate: (r) => callsByName(r, 'agent_create').length >= 1,
      },
      {
        id: 'spawned-after-create',
        description: 'Agent spawned a subagent after creating it',
        points: 3,
        phase: 'intention',
        validate: (r) => spawnCount(r) >= 1,
      },
      {
        id: 'awaited-result',
        description: 'Agent awaited the subagent result',
        points: 3,
        phase: 'intention',
        validate: (r) => awaitedAtLeastOneResult(r),
      },
      {
        id: 'mentions-console-log',
        description: 'Final response mentions the console.log finding',
        points: 3,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('console.log'),
      },
    ],
    maxScore: 12,
  },

  // -------------------------------------------------------------------------
  // Smoke 3: parallel spawns + synthesis of multiple results
  // -------------------------------------------------------------------------
  {
    id: 'subagent-smoke-parallel-synthesis',
    name: 'Spawns two subagents in parallel and synthesizes both results',
    category: 'subagent',
    level: 2,
    input:
      'I have two files (a.txt and b.txt). Each contains a single number. ' +
      'Spawn one subagent to read a.txt and another to read b.txt — in parallel. ' +
      'Wait for BOTH results, then reply with the sum of the two numbers and nothing else numeric.',
    workspaceFiles: {
      'a.txt': '17',
      'b.txt': '25',
    },
    validationCriteria: [
      {
        id: 'two-spawns',
        description: 'Agent spawned at least two subagents',
        points: 4,
        phase: 'intention',
        validate: (r) => spawnCount(r) >= 2,
      },
      {
        id: 'awaited-both',
        description: 'Agent fetched at least two results',
        points: 4,
        phase: 'intention',
        validate: (r) =>
          (callsByName(r, 'agent_result').length
            + callsByName(r, 'task_result').length) >= 2,
      },
      {
        id: 'correct-sum',
        description: 'Final response contains the correct sum (42)',
        points: 4,
        phase: 'execution',
        validate: (r) => /\b42\b/.test(r.responseText),
      },
    ],
    maxScore: 12,
  },
]

export default SUBAGENT_SMOKE_EVALS
