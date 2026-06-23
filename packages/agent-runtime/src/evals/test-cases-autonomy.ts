// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Autonomy / autonomous-completion evals (WS1).
 *
 * Reproduces the #1 user-friction pattern in production: the agent stops
 * mid-task to ask permission to continue. Telemetry: ~846 bare "continue"
 * user messages / 5 days, 13.5% of assistant turns ending with a question,
 * and ask_user firing 50-110x/day — much of it asking to proceed with work
 * the user already requested.
 *
 * These cases reward finishing an already-authorized multi-step task in one
 * turn WITHOUT calling ask_user or ending on a permission question, while a
 * balance case confirms the agent STILL asks when the request is genuinely
 * ambiguous (guards against over-correcting into never asking).
 *
 * Track: --track autonomy   ([L] cases run --local; the VM case needs --vm)
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, neverUsedTool } from './eval-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERMISSION_QUESTION_PATTERNS: RegExp[] = [
  /\bshould i (start|proceed|continue|go ahead|begin|build|create|implement)\b/i,
  /\bshall i (start|proceed|continue|go ahead|begin)\b/i,
  /\b(do|would) you (want|like) me to (start|proceed|continue|go ahead|build|create|implement)\b/i,
  /\bwant me to (start|proceed|continue|go ahead|build|keep going)\b/i,
  /\blet me know if (you|i should|you'd like|you want)\b/i,
  /\bready to (start|proceed|begin)\?/i,
  /\bshould i keep going\b/i,
]

/**
 * True if the response's tail reads as the agent asking permission to do work
 * it could have just done (the stop-and-ask anti-pattern). Looks at the last
 * ~300 chars so a clarifying question buried mid-summary doesn't false-trigger.
 */
function endsAskingPermission(r: EvalResult): boolean {
  const text = r.responseText.trim()
  if (text.length === 0) return false
  const tail = text.slice(-300)
  return PERMISSION_QUESTION_PATTERNS.some(re => re.test(tail))
}

/** True if the agent wrote (write_file or created via edit_file) a path containing `substring`. */
function wroteFile(r: EvalResult, substring: string): boolean {
  return r.toolCalls.some(t =>
    (t.name === 'write_file' || t.name === 'edit_file') &&
    String((t.input as Record<string, unknown>).path ?? '').includes(substring),
  )
}

// ---------------------------------------------------------------------------
// A. Complete an authorized multi-step task without asking permission
// ---------------------------------------------------------------------------

const COMPLETION_EVALS: AgentEval[] = [
  {
    id: 'autonomy-complete-multistep-calculator',
    name: 'Finish a multi-step build without asking to continue',
    category: 'tool-usage',
    level: 2,
    tags: ['prod:premature-stop-continue'],
    input: [
      'Create a small calculator module. This is the complete task — do all of it now, do not stop to ask whether to proceed:',
      '1. Write `src/calc.ts` exporting `add`, `subtract`, `multiply`, and `divide` (divide must throw on divide-by-zero).',
      '2. Write `src/calc.test.ts` with one test per function.',
      'When finished, give a one-line summary of what you created.',
    ].join('\n'),
    workspaceFiles: {},
    validationCriteria: [
      {
        id: 'wrote-impl',
        description: 'Created src/calc.ts',
        points: 4,
        phase: 'execution',
        validate: (r) => wroteFile(r, 'calc.ts'),
      },
      {
        id: 'wrote-test',
        description: 'Created the test file',
        points: 4,
        phase: 'execution',
        validate: (r) => wroteFile(r, 'calc.test'),
      },
      {
        id: 'no-ask-user',
        description: 'Did NOT call ask_user for an already-authorized task',
        points: 4,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'ask_user'),
      },
      {
        id: 'no-permission-ending',
        description: 'Did not end the turn asking permission to continue',
        points: 3,
        phase: 'execution',
        validate: (r) => !endsAskingPermission(r),
      },
    ],
    antiPatterns: [
      'Stopped to ask the user whether to proceed with already-requested work',
      'Ended the turn asking "should I continue?" instead of finishing',
    ],
    maxScore: 15,
  },

  {
    id: 'autonomy-no-midtask-checkpoint',
    name: 'Do not stop after step 1 to confirm before step 2',
    category: 'tool-usage',
    level: 2,
    tags: ['prod:premature-stop-continue'],
    input: [
      'Set up a tiny config + loader. Complete both steps in this turn:',
      '1. Write `config.json` with {"retries": 3, "timeoutMs": 1000}.',
      '2. Write `src/loadConfig.ts` that reads and parses config.json and exports a `loadConfig()` function.',
      'Do not pause between steps to confirm — just finish and summarize.',
    ].join('\n'),
    workspaceFiles: {},
    validationCriteria: [
      {
        id: 'wrote-config',
        description: 'Created config.json',
        points: 4,
        phase: 'execution',
        validate: (r) => wroteFile(r, 'config.json'),
      },
      {
        id: 'wrote-loader',
        description: 'Created src/loadConfig.ts',
        points: 4,
        phase: 'execution',
        validate: (r) => wroteFile(r, 'loadConfig'),
      },
      {
        id: 'no-ask-user',
        description: 'Did NOT call ask_user mid-task',
        points: 4,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'ask_user'),
      },
      {
        id: 'no-permission-ending',
        description: 'Did not end asking permission to continue',
        points: 3,
        phase: 'execution',
        validate: (r) => !endsAskingPermission(r),
      },
    ],
    antiPatterns: [
      'Paused after the first file to ask whether to continue',
    ],
    maxScore: 15,
  },
]

// ---------------------------------------------------------------------------
// B. Balance guard — STILL ask when the request is genuinely ambiguous
// ---------------------------------------------------------------------------

const BALANCE_EVALS: AgentEval[] = [
  {
    id: 'autonomy-ask-when-genuinely-ambiguous',
    name: 'Ask for direction on a truly underspecified request',
    category: 'tool-usage',
    level: 2,
    input: 'Build me an app.',
    workspaceFiles: {},
    validationCriteria: [
      {
        id: 'asked-for-clarity',
        description: 'Used ask_user to clarify what to build (genuine ambiguity)',
        points: 8,
        phase: 'execution',
        validate: (r) => usedTool(r, 'ask_user'),
      },
      {
        id: 'did-not-build-blind',
        description: 'Did not scaffold a random app before clarifying',
        points: 4,
        phase: 'execution',
        validate: (r) => !wroteFile(r, '.ts') && !wroteFile(r, '.tsx'),
      },
    ],
    antiPatterns: [
      'Built an arbitrary app without clarifying the completely unspecified request',
    ],
    maxScore: 12,
  },
]

// ---------------------------------------------------------------------------
// C. VM end-to-end — complete a real canvas build without permission-asking
// ---------------------------------------------------------------------------

const VM_EVALS: AgentEval[] = [
  {
    id: 'autonomy-vm-complete-counter-feature',
    name: 'Build a working counter component end-to-end without stopping',
    category: 'canvas-v2',
    level: 3,
    input: [
      'In this React app, add a `Counter` component in `src/components/Counter.tsx` with + / - buttons and a displayed count,',
      'and render it in `src/App.tsx`. Complete the whole change in this turn and verify it type-checks — do not stop to ask whether to proceed.',
    ].join('\n'),
    useRuntimeTemplate: true,
    workspaceFiles: {},
    tags: ['vm', 'prod:premature-stop-continue'],
    validationCriteria: [
      {
        id: 'created-counter',
        description: 'Created src/components/Counter.tsx',
        points: 5,
        phase: 'execution',
        validate: (r) => wroteFile(r, 'Counter'),
      },
      {
        id: 'wired-into-app',
        description: 'Edited src/App.tsx to render the component',
        points: 4,
        phase: 'execution',
        validate: (r) => wroteFile(r, 'App.tsx'),
      },
      {
        id: 'no-ask-user',
        description: 'Did NOT call ask_user for the authorized task',
        points: 4,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'ask_user'),
      },
      {
        id: 'no-permission-ending',
        description: 'Did not end asking permission to continue',
        points: 3,
        phase: 'execution',
        validate: (r) => !endsAskingPermission(r),
      },
    ],
    antiPatterns: [
      'Stopped mid-build to ask whether to continue',
    ],
    maxScore: 16,
  },
]

// ---------------------------------------------------------------------------
// Export combined
// ---------------------------------------------------------------------------

export const AUTONOMY_EVALS: AgentEval[] = [
  ...COMPLETION_EVALS,
  ...BALANCE_EVALS,
  ...VM_EVALS,
]
