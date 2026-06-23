// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Checkpoint / work-loss evals (WS4).
 *
 * Reproduces the production "work loss / restarts" pattern: ~45 sessions/5d
 * where a user asked to go back / restore and the agent said "there is no git
 * history" and hand-reverted — even though a full auto-checkpoint+rollback
 * system exists. The new `checkpoint` tool (list/diff/rollback) gives the agent
 * access to it.
 *
 * These [L] cases mock the `checkpoint` tool via `toolMocks` so they run
 * deterministically without the API; the [VM] case exercises the same flow in
 * a real sandbox. Each rewards using the checkpoint tool on a revert request
 * and penalizes the "no git history" lie.
 *
 * Track: --track checkpoints
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import type { ToolMockMap } from './tool-mocks'
import { usedTool } from './eval-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkpointCalls(r: EvalResult): ToolCallRecord[] {
  return r.toolCalls.filter(t => t.name === 'checkpoint')
}

function usedCheckpointAction(r: EvalResult, action: string): boolean {
  return checkpointCalls(r).some(t => (t.input as Record<string, unknown>).action === action)
}

const NO_HISTORY_PATTERNS: RegExp[] = [
  /no (git )?history/i,
  /don'?t have (any |access to )?(git |the )?history/i,
  /there'?s no (previous|earlier|prior) (version|state|checkpoint)/i,
  /can'?t (find|access|see) (any )?(git |the )?(history|checkpoints|previous versions)/i,
  /no (previous|earlier) (versions?|checkpoints?) (to|available)/i,
]

/** True if the agent did NOT falsely claim there is no history to revert to. */
function noNoHistoryClaim(r: EvalResult): boolean {
  return !NO_HISTORY_PATTERNS.some(re => re.test(r.responseText))
}

function wroteFilePath(r: EvalResult, toolName: string, substring: string): boolean {
  return r.toolCalls.some(t =>
    t.name === toolName &&
    String((t.input as Record<string, unknown>).path ?? '').includes(substring),
  )
}

// ---------------------------------------------------------------------------
// Shared mock: a project with three auto-checkpoints
// ---------------------------------------------------------------------------

const CHECKPOINT_MOCKS: ToolMockMap = {
  checkpoint: {
    type: 'pattern',
    paramKeys: ['action', 'checkpoint_id'],
    patterns: [
      {
        match: { action: 'list' },
        response: {
          checkpoints: [
            { id: 'cp_3', message: 'Add dark mode toggle', createdAt: '2026-06-20T10:00:00Z', automatic: true },
            { id: 'cp_2', message: 'Add header and nav', createdAt: '2026-06-20T09:30:00Z', automatic: true },
            { id: 'cp_1', message: 'Initial scaffold', createdAt: '2026-06-20T09:00:00Z', automatic: true },
          ],
          count: 3,
          hint: 'To revert, call checkpoint with action="rollback" and the chosen checkpoint_id.',
        },
      },
      {
        match: { action: 'rollback' },
        response: {
          ok: true,
          rolledBack: true,
          note: 'Restored to the requested checkpoint. A new checkpoint was created first, so this is reversible. Re-verify the app still works.',
        },
      },
      {
        match: { action: 'diff' },
        response: { diff: { files: ['src/App.tsx'], additions: 12, deletions: 3 } },
      },
    ],
    default: { checkpoints: [], count: 0, hint: 'No checkpoints recorded yet for this project.' },
  },
}

// ---------------------------------------------------------------------------
// A. Revert request must use the checkpoint tool (not claim "no history")
// ---------------------------------------------------------------------------

const REVERT_EVALS: AgentEval[] = [
  {
    id: 'checkpoint-revert-uses-tool',
    name: 'Go back to before a change using the checkpoint tool',
    category: 'tool-usage',
    level: 2,
    tags: ['prod:work-loss-restore'],
    input: 'Undo your last change — go back to the version before you added the dark mode toggle.',
    workspaceFiles: { 'src/App.tsx': 'export default function App() { return <div>app</div> }\n' },
    toolMocks: CHECKPOINT_MOCKS,
    validationCriteria: [
      {
        id: 'listed-checkpoints',
        description: 'Agent listed checkpoints to find the target',
        points: 4,
        phase: 'execution',
        validate: (r) => usedCheckpointAction(r, 'list'),
      },
      {
        id: 'rolled-back',
        description: 'Agent rolled back via the checkpoint tool',
        points: 5,
        phase: 'execution',
        validate: (r) => usedCheckpointAction(r, 'rollback'),
      },
      {
        id: 'no-false-no-history',
        description: 'Did not falsely claim there is no git history',
        points: 4,
        phase: 'execution',
        validate: (r) => noNoHistoryClaim(r),
      },
    ],
    antiPatterns: [
      'Claimed "there is no git history" instead of using checkpoints',
      'Hand-reverted by rewriting files from memory',
    ],
    maxScore: 13,
  },

  {
    id: 'checkpoint-restore-never-denies-history',
    name: 'Restore request — never deny that history exists',
    category: 'tool-usage',
    level: 2,
    tags: ['prod:no-git-history-claim'],
    input: 'I think I lost some work. Can you restore an earlier version of the project?',
    workspaceFiles: { 'src/App.tsx': 'export default function App() { return <div>app</div> }\n' },
    toolMocks: CHECKPOINT_MOCKS,
    validationCriteria: [
      {
        id: 'consulted-checkpoints',
        description: 'Agent consulted the checkpoint history',
        points: 6,
        phase: 'execution',
        validate: (r) => usedTool(r, 'checkpoint'),
      },
      {
        id: 'no-false-no-history',
        description: 'Did not claim there is no history / nothing to restore',
        points: 5,
        phase: 'execution',
        validate: (r) => noNoHistoryClaim(r),
      },
    ],
    antiPatterns: [
      'Told the user there was no way to restore / no history',
    ],
    maxScore: 11,
  },
]

// ---------------------------------------------------------------------------
// B. Resume — reconcile with existing workspace, don't recreate from scratch
// ---------------------------------------------------------------------------

const RESUME_EVALS: AgentEval[] = [
  {
    id: 'checkpoint-resume-no-recreate',
    name: 'Resume work without recreating existing files',
    category: 'tool-usage',
    level: 2,
    tags: ['prod:resume-started-over'],
    input: 'Continue where we left off — add a footer with a copyright line to the existing page.',
    workspaceFiles: {
      'src/App.tsx': [
        'import { Header } from "./Header"',
        'export default function App() {',
        '  return (',
        '    <div>',
        '      <Header />',
        '      <main>Welcome</main>',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
      'src/Header.tsx': 'export function Header() { return <header>My Site</header> }\n',
    },
    toolMocks: CHECKPOINT_MOCKS,
    validationCriteria: [
      {
        id: 'read-existing-first',
        description: 'Agent read the existing App.tsx before changing it',
        points: 5,
        phase: 'execution',
        validate: (r) => wroteFilePath(r, 'read_file', 'App.tsx'),
      },
      {
        id: 'edited-not-overwrote',
        description: 'Agent edited App.tsx rather than overwriting it with write_file',
        points: 5,
        phase: 'execution',
        validate: (r) =>
          wroteFilePath(r, 'edit_file', 'App.tsx') && !wroteFilePath(r, 'write_file', 'App.tsx'),
      },
      {
        id: 'did-not-recreate-header',
        description: 'Did not recreate the already-existing Header.tsx from scratch',
        points: 3,
        phase: 'execution',
        validate: (r) => !wroteFilePath(r, 'write_file', 'Header.tsx'),
      },
    ],
    antiPatterns: [
      'Recreated existing files / scaffolded from scratch instead of continuing',
    ],
    maxScore: 13,
  },
]

// ---------------------------------------------------------------------------
// C. VM — same revert flow exercised in a real sandbox
// ---------------------------------------------------------------------------

const VM_EVALS: AgentEval[] = [
  {
    id: 'checkpoint-vm-revert-flow',
    name: 'Revert flow end-to-end in the sandbox',
    category: 'tool-usage',
    level: 3,
    input: 'Roll the project back to the initial scaffold checkpoint.',
    useRuntimeTemplate: true,
    toolMocks: CHECKPOINT_MOCKS,
    tags: ['vm', 'prod:work-loss-restore'],
    validationCriteria: [
      {
        id: 'listed-then-rolled-back',
        description: 'Agent listed checkpoints and then rolled back',
        points: 8,
        phase: 'execution',
        validate: (r) => usedCheckpointAction(r, 'list') && usedCheckpointAction(r, 'rollback'),
      },
      {
        id: 'no-false-no-history',
        description: 'Did not falsely claim there is no git history',
        points: 4,
        phase: 'execution',
        validate: (r) => noNoHistoryClaim(r),
      },
    ],
    antiPatterns: [
      'Claimed there was no history instead of using the checkpoint tool',
    ],
    maxScore: 12,
  },
]

// ---------------------------------------------------------------------------
// Export combined
// ---------------------------------------------------------------------------

export const CHECKPOINT_EVALS: AgentEval[] = [
  ...REVERT_EVALS,
  ...RESUME_EVALS,
  ...VM_EVALS,
]
