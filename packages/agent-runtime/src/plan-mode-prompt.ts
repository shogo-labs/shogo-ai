// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Interaction-mode (agent / plan / ask) tool restrictions and system prompts,
 * plus the Auto-routing floor for plan turns.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { restrictToReadOnlyTools } from './read-only-command'

export type InteractionMode = 'agent' | 'plan' | 'ask'

/**
 * Read-only tools a plan-mode turn may use (create_plan/update_plan write only
 * under .shogo/plans/; `exec` is swapped for its read-only form).
 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'exec',
  'impact_radius',
  'read_lints',
  'search',
  'web',
  'memory_read',
  'memory_search',
  'search_history',
  'read_history',
  'ask_user',
  'todo_write',
  'create_plan',
  'update_plan',
  'skill',
])

/** `ask` -> no tools; `plan` -> the read-only allowlist; `agent` -> unchanged. */
export function filterToolsForMode(tools: AgentTool[], mode: InteractionMode | undefined): AgentTool[] {
  if (mode === 'ask') return []
  if (mode === 'plan') return restrictToReadOnlyTools(tools, PLAN_MODE_ALLOWED_TOOLS)
  return tools
}

export const ASK_MODE_PROMPT = [
  '## ASK MODE ACTIVE',
  '',
  "Ask mode is active. You are in a read-only conversational mode. Answer the user's questions directly using your knowledge and conversation context. You have no tools available. Do not attempt to make changes, run commands, or take any actions. Just provide helpful, informative answers.",
].join('\n')

export function buildPlanModePrompt({ searchEnabled }: { searchEnabled: boolean }): string {
  const tools = ['read_file', 'exec', 'impact_radius', 'read_lints', 'web', ...(searchEnabled ? ['search'] : [])]
  return [
    '## PLAN MODE ACTIVE',
    '',
    'Plan mode is active. You MUST NOT edit source files, run mutating commands, or otherwise change the workspace before the user clicks Build. This supersedes all other instructions.',
    'Exception: you may create or update the plan artifact using create_plan/update_plan; those tools only write under .shogo/plans/ for user review.',
    '',
    'Every plan you produce is delivered through `create_plan` — or `update_plan` when the user is revising a plan that already exists in `.shogo/plans/` (find it with `read_file` on that folder), or `ask_user` when you are blocked — design and rollout plans as much as code changes. A request that would change code always ends with a plan, including bug reports and one-line fixes, and even when the user does not say "plan". Never answer with a plan or a snippet in chat instead; the plan card is how the work gets reviewed and built.',
    'The editing tools (edit_file, write_file) do not exist in plan mode, and `exec` only runs read-only commands: `rg`, `git log|show|blame|grep|diff|status|ls-files|rev-parse`, `ls`, `find`, `cat`, `head`, `tail`, `wc` — one command per call, no pipes or redirects. The coding guide below describes how changes are made after the user clicks Build — use it to write the plan, not to make the change now.',
    '',
    `Read-only research tools: ${tools.map((t) => `\`${t}\``).join(', ')}.`,
    '',
    '### Investigation protocol (required before `create_plan`)',
    "1. Search with `exec` + `rg` (e.g. `rg -n 'MAX_TOKENS'`) for every symbol, literal, config key and error message in the request.",
    '2. Read the full path from where a value is configured (UI, settings, env, DB, config file) to where it is used — read every hop, not just the line that looks wrong.',
    "3. If the workspace is a git repository, check history with `exec` (`git log -S '<literal>'` to find when a value appeared, `git blame -L a,b <file>` for a line range) for suspicious hardcodes and recent changes, to learn why the code is the way it is.",
    '4. Find the existing tests for the code path.',
    '5. Run `impact_radius` on the files you plan to change.',
    '',
    '### Your job',
    "1. Research the user's request with the tools above, following the investigation protocol.",
    '2. If you need more information, ask clarifying questions using `ask_user`.',
    '3. If the request is too broad, ask 1-2 narrowing questions using `ask_user`.',
    '4. If there are multiple valid approaches, ask the user which they prefer.',
    '5. When you have enough context, call `create_plan` with a structured plan.',
    "6. If the user asks to modify, refine, or extend an existing plan, use `update_plan` with the plan's filepath instead of creating a new one.",
    '7. The plan should be complete and specific — cite file paths, line numbers and code; no padding.',
    '8. Do NOT make any changes until the user confirms the plan.',
    '',
    '### Required sections for plans that change code',
    '- `## Problem`',
    '- `## Root cause` — every claim cites `path:line` evidence.',
    '- `## Options considered` — at least two when a workaround exists, and why each rejected option was rejected.',
    '- `## Changes` — per file.',
    '- `## Tests`',
    '- `## Verification`',
    '- `## Risks`',
    '',
    '### Self-check before calling `create_plan`',
    'Does this plan remove the cause, or only mask the symptom? Would a senior reviewer ask "why not just fix X at its source?" If yes, revise the plan.',
  ].join('\n')
}

/** Closes a plan-mode system prompt: the rules above are 30k+ characters back by the time the model answers. */
export const PLAN_MODE_REMINDER = [
  '## PLAN MODE REMINDER',
  'You are still in plan mode. Research with the read-only tools, then finish by calling `create_plan` (or `update_plan` to revise an existing plan) — for any plan, not only code changes (code-change plans use the required sections: Problem, Root cause, Options considered, Changes, Tests, Verification, Risks). Do not write the plan into your reply instead of calling `create_plan`, and do not try to edit files.',
].join('\n')

/** Prepend the plan / ask mode prompt (plan mode also closes with a reminder); agent mode is unchanged. */
export function applyInteractionModePrompt(
  systemPrompt: string,
  mode: InteractionMode | undefined,
  { searchEnabled }: { searchEnabled: boolean },
): string {
  if (mode === 'plan') return `${buildPlanModePrompt({ searchEnabled })}\n\n---\n\n${systemPrompt}\n\n---\n\n${PLAN_MODE_REMINDER}`
  if (mode === 'ask') return `${ASK_MODE_PROMPT}\n\n---\n\n${systemPrompt}`
  return systemPrompt
}

/**
 * Auto routing never runs a plan turn on the economy tier: planning a code
 * change needs the investigation and judgment above. The session ceiling
 * still wins (see `floorTier` in the model router).
 */
export function autoFloorTierFor(mode: InteractionMode | undefined): 'standard' | undefined {
  return mode === 'plan' ? 'standard' : undefined
}

const PLAN_DELIVERY_TOOLS = new Set(['create_plan', 'update_plan', 'ask_user'])
const PLAN_HEADINGS = ['Problem', 'Root cause', 'Options considered', 'Changes', 'Tests']

const hasHeading = (text: string, title: string) =>
  new RegExp(`^#{1,4}\\s+${title.replace(' ', '\\s+')}\\b`, 'im').test(text)

/** A plan turn that ended with the plan written into the reply instead of delivered through `create_plan`. */
export function planWrittenInsteadOfCreated(
  mode: InteractionMode | undefined,
  toolNames: readonly string[],
  replyText: string,
): boolean {
  if (mode !== 'plan' || toolNames.some((name) => PLAN_DELIVERY_TOOLS.has(name))) return false
  if (PLAN_HEADINGS.filter((title) => hasHeading(replyText, title)).length >= 2) return true
  const headings = replyText.match(/^#{1,4}\s+.+$/gm) ?? []
  if (headings.length >= 2 && headings.some((h) => /\bplan\s*:?\s*$/i.test(h))) return true
  return (replyText.match(/^#{1,4}\s+(?:phase|step|stage)\s*\d/gim) ?? []).length >= 2
}

/** One bounded follow-up for {@link planWrittenInsteadOfCreated}. */
export const PLAN_DELIVERY_NUDGE =
  'You wrote a plan in your reply, but in plan mode a plan only reaches the user through `create_plan`. ' +
  'Call `create_plan` now with that plan (same sections and todos), then reply with one short sentence; do not repeat the plan in chat.'

const SOURCE_FILE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|vue|svelte|sql|prisma)\b/
const CODE_PLAN_SECTIONS = ['Root cause', 'Options considered'] as const

/**
 * Sections a code-change plan is missing. A plan "changes code" when it names
 * a source file; plans for other work (a trip, a launch) are left alone.
 */
export function missingCodePlanSections(planMarkdown: string): string[] {
  if (!SOURCE_FILE.test(planMarkdown)) return []
  return CODE_PLAN_SECTIONS.filter((title) => !hasHeading(planMarkdown, title))
}
