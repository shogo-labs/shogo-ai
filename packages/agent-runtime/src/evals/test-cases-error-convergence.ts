// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Error-convergence evals (WS3).
 *
 * Reproduces the production "non-converging bug" pattern: the agent fixes ONE
 * instance of a repeated/family error, re-runs, fixes the next, re-runs, and so
 * on — leading to "it's still broken / same error again" and ~337 substantive
 * resends/5d. These cases reward fixing the whole CLASS of error in a single
 * pass (e.g. via replace_all or batched edits) and penalize the run-fix-run-fix
 * loop.
 *
 * Track: --track error-convergence  ([L] runs --local; the VM case needs --vm)
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathOf(t: ToolCallRecord): string {
  return String((t.input as Record<string, unknown>).path ?? '')
}

function editCallsTo(r: EvalResult, substring: string): ToolCallRecord[] {
  return r.toolCalls.filter(t => t.name === 'edit_file' && pathOf(t).includes(substring))
}

function usedReplaceAll(r: EvalResult, substring: string): boolean {
  return editCallsTo(r, substring).some(t => (t.input as Record<string, unknown>).replace_all === true)
}

/** Count of "verification" calls (lint checks + build/test/curl exec). */
function verificationCount(r: EvalResult): number {
  return r.toolCalls.filter(t => {
    if (t.name === 'read_lints') return true
    if (t.name === 'exec') {
      const cmd = String((t.input as Record<string, unknown>).command ?? '')
      return /\b(tsc|build|vitest|jest|bun test|npm test|curl)\b/.test(cmd)
    }
    return false
  }).length
}

/**
 * True if the agent fixed the class in one pass rather than re-verifying after
 * every single edit. Either it used replace_all, OR it did not interleave a
 * verification between each edit (verifications <= 2 across the run).
 */
function convergedInOnePass(r: EvalResult, substring: string): boolean {
  if (usedReplaceAll(r, substring)) return true
  const edits = editCallsTo(r, substring).length
  return edits >= 1 && verificationCount(r) <= 2
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Four functions that all use the same typo `.lenght` — a single class of error
// repeated across the file. Fixing the class = one replace_all (or one batched
// pass), not four edit/re-run cycles.
const TYPO_CLASS_FILE = `export function first<T>(arr: T[]): T | undefined {
  if (arr.lenght === 0) return undefined
  return arr[0]
}

export function last<T>(arr: T[]): T | undefined {
  if (arr.lenght === 0) return undefined
  return arr[arr.lenght - 1]
}

export function middle<T>(arr: T[]): T | undefined {
  if (arr.lenght === 0) return undefined
  return arr[Math.floor(arr.lenght / 2)]
}

export function isEmpty<T>(arr: T[]): boolean {
  return arr.lenght === 0
}
`

// A component that calls .filter on a value that is an object, not an array —
// the canonical "X.filter is not a function" runtime crash.
const FILTER_CRASH_COMPONENT = `import { useState } from 'react'

// BUG: the API returns { items: [...] } but this treats the whole object as an
// array and calls .filter on it → "data.filter is not a function" at runtime.
export function TodoList({ data }: { data: { items: { id: number; done: boolean; text: string }[] } }) {
  const [showDone, setShowDone] = useState(true)
  const visible = data.filter((t: any) => showDone || !t.done)
  return (
    <ul>
      {visible.map((t: any) => <li key={t.id}>{t.text}</li>)}
    </ul>
  )
}
`

// ---------------------------------------------------------------------------
// A. [L] Fix the class, not the instance
// ---------------------------------------------------------------------------

const CLASS_FIX_EVALS: AgentEval[] = [
  {
    id: 'convergence-fix-typo-class',
    name: 'Fix a repeated typo across the file in one pass',
    category: 'edit-file',
    level: 2,
    tags: ['prod:repeat-nonconverging-bugs'],
    input: [
      '`src/array-utils.ts` has the typo `lenght` (it should be `length`) used in several functions.',
      'Fix every occurrence so the file type-checks. Do it efficiently — do not fix one and re-check, fix one and re-check.',
    ].join('\n'),
    workspaceFiles: { 'src/array-utils.ts': TYPO_CLASS_FILE },
    validationCriteria: [
      {
        id: 'edited-the-file',
        description: 'Agent edited src/array-utils.ts',
        points: 4,
        phase: 'execution',
        validate: (r) => editCallsTo(r, 'array-utils').length > 0,
      },
      {
        id: 'fixed-the-class',
        description: 'Fixed all occurrences in one pass (replace_all or batched, not run-fix-run)',
        points: 7,
        phase: 'execution',
        validate: (r) => convergedInOnePass(r, 'array-utils'),
      },
      {
        id: 'did-not-thrash',
        description: 'Did not re-verify after every single edit',
        points: 3,
        phase: 'execution',
        validate: (r) => verificationCount(r) <= 2,
      },
    ],
    antiPatterns: [
      'Fixed one occurrence, re-ran, fixed the next, re-ran (one-at-a-time loop)',
    ],
    maxScore: 14,
  },
]

// ---------------------------------------------------------------------------
// B. [VM] Resolve a canvas runtime crash from the runtime error
// ---------------------------------------------------------------------------

const RUNTIME_CRASH_EVALS: AgentEval[] = [
  {
    id: 'convergence-vm-filter-not-a-function',
    name: 'Resolve "filter is not a function" runtime crash',
    category: 'canvas-v2',
    level: 3,
    useRuntimeTemplate: true,
    tags: ['vm', 'prod:canvas-runtime-crash'],
    input: [
      'The Todo list page crashes at runtime with "data.filter is not a function".',
      'Fix it in `src/components/TodoList.tsx` so the list renders, and verify it no longer crashes.',
    ].join('\n'),
    workspaceFiles: { 'src/components/TodoList.tsx': FILTER_CRASH_COMPONENT },
    validationCriteria: [
      {
        id: 'edited-the-component',
        description: 'Agent edited the crashing component',
        points: 6,
        phase: 'execution',
        validate: (r) => editCallsTo(r, 'TodoList').length > 0 ||
          r.toolCalls.some(t => t.name === 'write_file' && pathOf(t).includes('TodoList')),
      },
      {
        id: 'verified',
        description: 'Agent verified the fix (lint/build/runtime check)',
        points: 5,
        phase: 'execution',
        validate: (r) => verificationCount(r) >= 1,
      },
      {
        id: 'converged',
        description: 'Did not loop fixing the same error repeatedly',
        points: 3,
        phase: 'execution',
        validate: (r) => editCallsTo(r, 'TodoList').length <= 3,
      },
    ],
    antiPatterns: [
      'Repeatedly edited without resolving the underlying data-shape bug',
    ],
    maxScore: 14,
  },
]

// ---------------------------------------------------------------------------
// Export combined
// ---------------------------------------------------------------------------

export const ERROR_CONVERGENCE_EVALS: AgentEval[] = [
  ...CLASS_FIX_EVALS,
  ...RUNTIME_CRASH_EVALS,
]
