// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace attachment awareness evals.
 *
 * Reproduces the multi-project (merged-root) workspace runtime where several
 * attached projects are mounted as top-level UUID folders alongside a
 * WORKSPACE.md manifest.
 *
 * Regression target: the agent used to deny it had any attached projects
 * ("I only have access to one project … those belong to other users' projects
 * — I won't access them") because WORKSPACE.md was never surfaced in the system
 * prompt — the agent only saw bare UUID folders in the file tree and refused
 * them on privacy grounds. These evals assert the agent now (a) knows about its
 * sibling projects, (b) reads across them, and (c) edits across them without a
 * bogus privacy/isolation refusal.
 *
 * Fixtures mirror a real merged root: WORKSPACE.md is generated with the same
 * renderWorkspaceManifestMarkdown() the runtime writes at boot, and each
 * project is a real subfolder seeded via `workspaceFiles`.
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, responseContains, toolCallArgsContain } from './eval-helpers'
import { renderWorkspaceManifestMarkdown } from '../workspace-runtime-mode'

// UUID folder names mirror the real runtime — the exact shape the agent used to
// mistake for unrelated / other-users' folders.
const ANCHOR_ID = '11111111-1111-4111-8111-111111111111'
const GREETING_ID = '22222222-2222-4222-8222-222222222222'
const SMOKE_ID = '33333333-3333-4333-8333-333333333333'

const PROJECTS = [
  { id: ANCHOR_ID, name: 'counter-app' },
  { id: GREETING_ID, name: 'greeting-app' },
  { id: SMOKE_ID, name: 'smoke-tester' },
]

const GREETING_README_FIRST_LINE = 'GREETING_SENTINEL_LINE_42'

// A merged root: the manifest at the root plus three real project subfolders.
const MERGED_ROOT_FILES: Record<string, string> = {
  'WORKSPACE.md': renderWorkspaceManifestMarkdown('eval-workspace', PROJECTS),
  [`${ANCHOR_ID}/index.html`]: '<!doctype html><h1>Counter</h1>\n',
  [`${ANCHOR_ID}/package.json`]: '{\n  "name": "counter-app"\n}\n',
  [`${GREETING_ID}/README.md`]: `${GREETING_README_FIRST_LINE}\nA tiny greeting service.\n`,
  [`${GREETING_ID}/index.html`]: '<!doctype html><h1>Greeting</h1>\n',
  [`${SMOKE_ID}/README.md`]: 'Smoke tester project.\nRuns smoke tests.\n',
}

// Phrases that signal the agent wrongly disowned / refused its attached
// projects. checkAntiPattern() in runner.ts only honours a hardcoded set of
// tags, so the refusal gate has to be a validationCriterion, not an antiPattern.
const REFUSAL_PHRASES = [
  'other user',
  'another user',
  'privacy violation',
  "won't access",
  'will not access',
  'cannot access',
  "can't access",
  'only have access to one',
  'only one project',
  'only see the project',
  'not allowed',
  'outside the workspace',
]

function refusesAttachedProjects(result: EvalResult): boolean {
  const text = result.responseText.toLowerCase()
  return REFUSAL_PHRASES.some((p) => text.includes(p))
}

export const WORKSPACE_ATTACHMENT_EVALS: AgentEval[] = [
  {
    id: 'workspace-attach-awareness',
    name: 'Knows about its attached projects',
    category: 'workspace-attachments',
    level: 1,
    input: 'What other projects can you see in this workspace?',
    initialMode: 'none',
    workspaceFiles: MERGED_ROOT_FILES,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-refusal',
        description: "Does not disown the attached projects or refuse on privacy/isolation grounds",
        phase: 'execution',
        points: 40,
        validate: (r) => !refusesAttachedProjects(r),
      },
      {
        id: 'mentions-greeting',
        description: 'Names the greeting-app attached project',
        phase: 'execution',
        points: 25,
        validate: (r) => responseContains(r, 'greeting'),
      },
      {
        id: 'mentions-smoke',
        description: 'Names the smoke-tester attached project',
        phase: 'execution',
        points: 25,
        validate: (r) => responseContains(r, 'smoke'),
      },
      {
        id: 'acknowledges-multiple',
        description: 'Acknowledges more than one project',
        phase: 'execution',
        points: 10,
        validate: (r) => {
          const t = r.responseText.toLowerCase()
          return ['two', 'three', 'both', 'multiple', 'several'].some((w) => t.includes(w))
        },
      },
    ],
  },
  {
    id: 'workspace-attach-cross-read',
    name: 'Reads a file in an attached project',
    category: 'workspace-attachments',
    level: 2,
    input:
      `Read the file at ${GREETING_ID}/README.md (the "greeting-app" attached project) ` +
      'and quote its first line back to me verbatim.',
    initialMode: 'none',
    workspaceFiles: MERGED_ROOT_FILES,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-read-file',
        description: 'Calls read_file on the attached project path',
        phase: 'intention',
        points: 40,
        validate: (r) => usedTool(r, 'read_file') && toolCallArgsContain(r, 'read_file', GREETING_ID),
      },
      {
        id: 'quoted-sentinel',
        description: 'Quotes the first line of the attached README',
        phase: 'execution',
        points: 40,
        validate: (r) => responseContains(r, GREETING_README_FIRST_LINE),
      },
      {
        id: 'no-refusal',
        description: 'Does not refuse the cross-project read',
        phase: 'execution',
        points: 20,
        validate: (r) => !refusesAttachedProjects(r),
      },
    ],
  },
  {
    id: 'workspace-attach-cross-edit',
    name: 'Edits a file in an attached project',
    category: 'workspace-attachments',
    level: 2,
    input:
      `Create a file ${SMOKE_ID}/NOTES.md (in the "smoke-tester" attached project) ` +
      'containing exactly the single line: attached-write-ok. Then confirm you wrote it.',
    initialMode: 'none',
    workspaceFiles: MERGED_ROOT_FILES,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-file',
        description: 'Writes or edits a file in the attached project',
        phase: 'intention',
        points: 45,
        validate: (r) =>
          (usedTool(r, 'write_file') && toolCallArgsContain(r, 'write_file', SMOKE_ID)) ||
          (usedTool(r, 'edit_file') && toolCallArgsContain(r, 'edit_file', SMOKE_ID)),
      },
      {
        id: 'confirms-write',
        description: 'Confirms the write with the expected content',
        phase: 'execution',
        points: 30,
        validate: (r) => responseContains(r, 'attached-write-ok'),
      },
      {
        id: 'no-readonly-refusal',
        description: 'Does not falsely refuse the writable attached project',
        phase: 'execution',
        points: 25,
        validate: (r) => {
          const t = r.responseText.toLowerCase()
          return !refusesAttachedProjects(r) && !t.includes('read-only') && !t.includes('readonly')
        },
      },
    ],
  },
]

export default WORKSPACE_ATTACHMENT_EVALS
