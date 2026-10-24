// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill System Eval Test Cases
 *
 * Tests the skill system integration with the unified search_integrations / connect
 * interface, and skill CRUD via existing file tools.
 *
 * Covers:
 * - Skill discovery via search_integrations (skills alongside managed integrations)
 * - Skill installation via connect with "skill:" prefix
 * - Skill creation via write_file with correct frontmatter
 * - Skill editing via read + edit/write (any route)
 * - Skill deletion via delete_file or exec rm
 * - Full lifecycle: search → install → read → execute
 */

import type { AgentEval, EvalResult } from './types'
import {
  SKILL_SEARCH_MIXED_MOCKS,
  SKILL_INSTALL_MOCKS,
  SKILL_LIFECYCLE_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  didNotUseToolInFinalTurn,
  responseContains,
  toolCallsJson,
  toolCallArgsContain,
  deletedFileAnyRoute,
  execCommands,
  execIsSearch,
  fileWrites,
  readFileAnyRoute,
  readWorkspaceFile,
  wroteFileAnyRoute,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------

/** Used the `skill` tool on `name` (install, or invoke — which loads its instructions). */
function usedSkillTool(r: EvalResult, name: string, actions = ['install', 'invoke']): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'skill') return false
    const input = t.input as Record<string, unknown>
    const action = String(input.action ?? 'invoke')
    return actions.includes(action) && JSON.stringify(input).toLowerCase().includes(name)
  })
}

/** Installed a skill via `connect({ name: "skill:<name>" })` or the `skill` tool. */
function installedSkill(r: EvalResult, name: string): boolean {
  return toolCallArgsContain(r, 'connect', `skill:${name}`) || usedSkillTool(r, name)
}

/** Loaded a skill's instructions: read its SKILL.md (any route) or invoked it via the `skill` tool. */
function readSkill(r: EvalResult, name: string): boolean {
  return readFileAnyRoute(r, (p) => p.includes(name)) || usedSkillTool(r, name, ['invoke'])
}

const isSkillPath = (p: string) => p.includes('.shogo/skills/') || /(^|\/)skills\//.test(p)

/** Content written to skill files via write_file (full content) or exec heredoc. */
function skillFileWrites(r: EvalResult): string[] {
  return fileWrites(r).filter(w => isSkillPath(w.path) && w.via !== 'edit_file').map(w => w.content)
}

const STANDUP_SKILL = '.shogo/skills/standup-collect/SKILL.md'

/**
 * 116 no-op skills used by the prompt-budget regression case (SHO-57).
 * With the real runbook below that is 117 skills — long enough that the
 * `## Available Skills` listings overflow the 16k budget, so the last one
 * is exactly what the old loop used to cut silently.
 */
const SKILL_BUDGET_FILLERS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 116 }, (_, i) => {
    const name = `filler-${String(i + 1).padStart(3, '0')}`
    return [
      `.shogo/skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Placeholder skill ${String(i + 1).padStart(3, '0')} — exists only to fill this workspace's skill list so the prompt budget is exercised; it does nothing and should never be invoked.\n---\n\n# ${name}\n\nPlaceholder. Nothing to do here.\n`,
    ]
  }),
)

/** The standup skill after this turn: the workspace file, else every write to it. */
function standupSkillAfter(r: EvalResult): string {
  return readWorkspaceFile(r, STANDUP_SKILL) ||
    fileWrites(r).filter(w => w.path.includes('standup')).map(w => w.content).join('\n')
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const SKILL_SYSTEM_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Skill search returns skills alongside integrations
  // Level 2 | Agent searches for capabilities and sees mixed results
  // =========================================================================
  {
    id: 'skill-search-mixed-results',
    name: 'Skill System: Search returns skills alongside integrations',
    category: 'skill',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'I need to monitor my GitHub PRs and also run health checks on my site.' },
    ],
    input: 'Just search for what\'s available and show me the options. Don\'t install anything yet.',
    maxScore: 100,
    toolMocks: SKILL_SEARCH_MIXED_MOCKS,
    validationCriteria: [
      {
        id: 'used-tool-search',
        description: 'Used search_integrations to discover capabilities',
        points: 20,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'searched-github',
        description: 'Search query covers github or PR',
        points: 15,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('github') || json.includes('pr')
        },
      },
      {
        id: 'searched-health',
        description: 'Search query covers health check or site',
        points: 15,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('health') || json.includes('site') || json.includes('seo') || json.includes('check')
        },
      },
      {
        id: 'did-not-install',
        description: 'Did NOT install anything in the final turn — user said just show options',
        points: 20,
        phase: 'execution',
        validate: (r) => didNotUseToolInFinalTurn(r, 'connect'),
      },
      {
        id: 'response-mentions-results',
        description: 'Response mentions both skill and integration results',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          (responseContains(r, 'github') || responseContains(r, 'pr')) &&
          (responseContains(r, 'skill') || responseContains(r, 'health') || responseContains(r, 'ops')),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 6 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 6,
      },
    ],
    antiPatterns: [
      'Agent installed tools when user explicitly said not to',
    ],
  },

  // =========================================================================
  // Case 2: Install a bundled skill via connect
  // Level 2 | Agent installs a skill using the "skill:" prefix
  // =========================================================================
  {
    id: 'skill-install-bundled',
    name: 'Skill System: Install bundled skill via connect',
    category: 'skill',
    level: 2,
    input: 'Install the GitHub ops skill so I can track my repos.',
    maxScore: 100,
    toolMocks: SKILL_INSTALL_MOCKS,
    validationCriteria: [
      {
        id: 'used-tool-install',
        description: 'Installed the skill (connect with skill: prefix, or the skill tool)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect') || usedSkillTool(r, 'github'),
      },
      {
        id: 'install-with-skill-prefix',
        description: 'Targeted the github-ops skill (connect "skill:github-ops" or skill tool)',
        points: 25,
        phase: 'execution',
        validate: (r) => installedSkill(r, 'github-ops'),
      },
      {
        id: 'read-skill-after-install',
        description: 'Agent loaded the skill instructions (read SKILL.md or skill invoke)',
        points: 20,
        phase: 'execution',
        validate: (r) => readSkill(r, 'github-ops'),
      },
      {
        id: 'response-confirms-install',
        description: 'Response confirms successful installation',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'install') || responseContains(r, 'active') || responseContains(r, 'github-ops'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 8,
      },
    ],
    antiPatterns: [
      'Agent tried to write the skill file manually instead of using connect',
    ],
  },

  // =========================================================================
  // Case 3: Create a custom skill via write_file
  // Level 3 | Agent creates a new skill as a Markdown file with frontmatter
  // =========================================================================
  {
    id: 'skill-create-custom',
    name: 'Skill System: Create custom skill via write_file',
    category: 'skill',
    level: 3,
    input: 'Create a skill that monitors our Slack mentions every hour. It should check for mentions of our company name and send me a summary.',
    maxScore: 100,
    workspaceFiles: {
      '.shogo/skills/standup-collect/SKILL.md': `---
name: standup-collect
version: 2.0.0
description: Collect and compile daily standup updates from the team
trigger: "standup|daily update|what did|yesterday|today plan|blockers"
tools: [send_message, memory_read, write_file, edit_file]
---

# Standup Collection

Facilitate daily standup updates:

1. **Prompt** — Send standup prompt to configured channel
2. **Collect** — Parse responses from the team
3. **Compile** — Build standup summary
4. **Track** — Save standup data to memory`,
    },
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Wrote a .md skill file under .shogo/skills/ (write_file or shell)',
        points: 25,
        phase: 'intention',
        validate: (r) => wroteFileAnyRoute(r, (p) => isSkillPath(p) && p.endsWith('.md')),
      },
      {
        id: 'has-name-field',
        description: 'Written content has name: in frontmatter',
        points: 15,
        phase: 'execution',
        validate: (r) => skillFileWrites(r).some(c => c.includes('name:') && c.includes('---')),
      },
      {
        id: 'has-trigger-field',
        description: 'Written content has trigger: with pipe-separated phrases',
        points: 15,
        phase: 'execution',
        validate: (r) => skillFileWrites(r).some(c => c.includes('trigger:') && c.includes('|')),
      },
      {
        id: 'has-markdown-body',
        description: 'Written content has a markdown body with instructions',
        points: 15,
        phase: 'execution',
        validate: (r) => skillFileWrites(r).some(c => {
          const parts = c.split('---')
          return parts.length >= 3 && parts[2].trim().length > 20
        }),
      },
      {
        id: 'path-in-skills-dir',
        description: 'File written to .shogo/skills/ directory',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteFileAnyRoute(r, isSkillPath),
      },
      {
        id: 'response-explains-skill',
        description: 'Response explains the skill and its triggers',
        points: 15,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'skill') &&
          (responseContains(r, 'trigger') || responseContains(r, 'mention') || responseContains(r, 'slack')),
      },
    ],
    antiPatterns: [
      'Agent asked clarifying questions instead of creating the skill with reasonable defaults',
    ],
  },

  // =========================================================================
  // Case 4: Edit an existing skill via file tools
  // Level 2 | Agent reads a skill, updates triggers and content, writes back
  // =========================================================================
  {
    id: 'skill-edit-existing',
    name: 'Skill System: Edit existing skill via file tools',
    category: 'skill',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'I have a standup collection skill installed.' },
      { role: 'assistant', content: 'I can see your standup-collect skill in the .shogo/skills/ directory. It collects daily standup updates from the team with triggers for "standup", "daily update", and related phrases. What would you like to change?' },
    ],
    input: 'Add a trigger for \'morning update\' to my standup skill and make it also post to the #general channel.',
    maxScore: 100,
    workspaceFiles: {
      '.shogo/skills/standup-collect/SKILL.md': `---
name: standup-collect
version: 2.0.0
description: Collect and compile daily standup updates from the team
trigger: "standup|daily update|what did|yesterday|today plan|blockers"
tools: [send_message, memory_read, write_file, edit_file]
---

# Standup Collection

Facilitate daily standup updates:

1. **Prompt** — Send standup prompt to configured channel
2. **Collect** — Parse responses from the team
3. **Compile** — Build standup summary
4. **Track** — Save standup data to memory
5. **Notify** — Post compiled summary to team channel via send_message`,
    },
    validationCriteria: [
      {
        id: 'read-skill-first',
        description: 'Read the skill before editing (read_file or shell)',
        points: 20,
        phase: 'intention',
        validate: (r) => readFileAnyRoute(r, (p) => p.includes('standup')),
      },
      {
        id: 'used-write-file',
        description: 'Updated the skill file (edit_file, write_file, or shell)',
        points: 25,
        phase: 'intention',
        validate: (r) => wroteFileAnyRoute(r, (p) => p.includes('standup')),
      },
      {
        id: 'has-valid-frontmatter',
        description: 'Updated skill still has valid frontmatter',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          if (!wroteFileAnyRoute(r, (p) => p.includes('standup'))) return false
          const content = standupSkillAfter(r)
          return content.trimStart().startsWith('---') && content.includes('name:') && content.includes('trigger:')
        },
      },
      {
        id: 'trigger-includes-morning-update',
        description: 'Updated trigger includes "morning update"',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const trigger = standupSkillAfter(r).split('\n').find(l => /^\s*trigger:/.test(l)) ?? ''
          return trigger.toLowerCase().includes('morning update')
        },
      },
      {
        id: 'body-mentions-general',
        description: 'Updated body mentions #general channel',
        points: 15,
        phase: 'execution',
        validate: (r) => standupSkillAfter(r).toLowerCase().includes('general'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 8,
      },
    ],
    antiPatterns: [
      'Agent overwrote the skill without reading it first',
    ],
  },

  // =========================================================================
  // Case 5: Skill discovery + install + use lifecycle
  // Level 4 | End-to-end: search → install → read → follow instructions
  // =========================================================================
  {
    id: 'skill-lifecycle-end-to-end',
    name: 'Skill System: Full lifecycle — search, install, read, execute',
    category: 'skill',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I want to run health checks on my web services to make sure they\'re all up.' },
      { role: 'assistant', content: 'I used `search_integrations` and found a **health-check** skill in the skill library. It runs health checks on web services and APIs — checking endpoints, recording status codes and response times, building a dashboard, and alerting on failures.\n\nTo install it, I\'d run `connect({ name: "skill:health-check" })`, then read the skill file to follow its instructions. Want me to go ahead?' },
    ],
    input: 'Yes, install it and run a check on https://api.example.com and https://www.example.com.',
    maxScore: 100,
    toolMocks: SKILL_LIFECYCLE_MOCKS,
    validationCriteria: [
      {
        id: 'installed-skill',
        description: 'Installed the skill (connect with skill: prefix, or the skill tool)',
        points: 25,
        phase: 'intention',
        validate: (r) => installedSkill(r, 'health-check'),
      },
      {
        id: 'read-skill-instructions',
        description: 'Loaded the installed skill instructions (read SKILL.md or skill invoke)',
        points: 20,
        phase: 'execution',
        validate: (r) => readSkill(r, 'health-check'),
      },
      {
        id: 'followed-instructions-web',
        description: 'Followed skill instructions — used web tool for health checks',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'web'),
      },
      {
        id: 'response-includes-findings',
        description: 'Response includes health check findings or status',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'health') || responseContains(r, 'status') ||
          responseContains(r, 'ok') || responseContains(r, 'operational'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Agent fabricated health check data without using the web tool',
    ],
  },

  // =========================================================================
  // Case 6: Delete a skill via file tools
  // Level 1 | Simple deletion of an installed skill
  // =========================================================================
  {
    id: 'skill-delete-existing',
    name: 'Skill System: Delete skill via file tools',
    category: 'skill',
    level: 1,
    input: 'Remove the reminder-manage skill, I don\'t use it anymore.',
    maxScore: 100,
    workspaceFiles: {
      '.shogo/skills/reminder-manage/SKILL.md': `---
name: reminder-manage
version: 2.0.0
description: Set and manage reminders — store in memory, check on heartbeat, notify when due
trigger: "remind me|set reminder|reminder|don't forget|remember to|alarm|due"
tools: [memory_read, send_message]
---

# Reminder Management

Manage reminders stored in agent memory.`,
      '.shogo/skills/standup-collect/SKILL.md': `---
name: standup-collect
version: 2.0.0
description: Collect and compile daily standup updates from the team
trigger: "standup|daily update|what did|yesterday|today plan|blockers"
tools: [send_message, memory_read]
---

# Standup Collection

Facilitate daily standup updates.`,
    },
    validationCriteria: [
      {
        id: 'verified-skill-exists',
        description: 'Confirmed the skill exists (read it, or listed/searched the skills dir)',
        points: 20,
        phase: 'intention',
        validate: (r) =>
          readFileAnyRoute(r, (p) => p.includes('reminder')) ||
          execCommands(r).some(c => execIsSearch(c) && /skills|reminder/.test(c)),
      },
      {
        id: 'used-delete-file',
        description: 'Deleted the reminder-manage skill (delete_file or exec rm — delete_file only works under files/)',
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const deleted = deletedFileAnyRoute(r, '.shogo/skills/reminder-manage/SKILL.md')
          if (!r.workspaceDir) return deleted
          return deleted && !readWorkspaceFile(r, '.shogo/skills/reminder-manage/SKILL.md')
        },
      },
      {
        id: 'response-confirms-deletion',
        description: 'Response confirms the skill was removed',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'remov') || responseContains(r, 'delet') || responseContains(r, 'gone'),
      },
      {
        id: 'did-not-delete-other-skills',
        description: 'Did NOT delete any other skill files',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          if (r.workspaceDir && !readWorkspaceFile(r, STANDUP_SKILL)) return false
          return !deletedFileAnyRoute(r, STANDUP_SKILL) && !deletedFileAnyRoute(r, '.shogo/skills/x')
        },
      },
    ],
  },

  // =========================================================================
  // Case 7: SHO-57 — a skill at the tail of a 117-skill list must be found
  // Level 3 | Discovery has to survive a truncated `## Available Skills` block
  // =========================================================================
  {
    id: 'skill-tail-of-large-list',
    name: 'Skill System: find and invoke a skill at the end of a 117-skill list',
    category: 'skill',
    level: 3,
    input:
      "We're cutting our marketing site's DNS over to Cloudflare on Thursday and I want the exact procedure in hand. Use the DNS cutover runbook skill you have installed and walk me through the key steps.",
    maxScore: 100,
    workspaceFiles: {
      ...SKILL_BUDGET_FILLERS,
      // Seeded under the `.claude/skills/` compat path on purpose: `loadAllSkills`
      // returns `.shogo/skills` entries first and `.claude/skills` entries last,
      // so this is deterministically the 117th listing regardless of directory
      // read order — i.e. exactly the tail the 16k cut used to drop silently.
      //
      // No `trigger:` on purpose. With one, `matchSkill` would match the prompt
      // and inject this whole body into the turn before the `## Available Skills`
      // list is ever consulted — the truncation would not matter and the case
      // would score the same on `main` (verified: 40/100 both sides). Discovery
      // has to go through the listing (and `skill search` when the list is cut).
      '.claude/skills/zz-dns-cutover-runbook/SKILL.md': `---
name: zz-dns-cutover-runbook
version: 1.4.0
description: Step-by-step DNS cutover runbook for moving a live domain to a new provider without downtime
tools: [exec, read_file]
---

# DNS Cutover Runbook

Proven procedure for moving a production domain to a new DNS provider with no
downtime. Follow it in order; every step has a verification command.

1. Snapshot the current zone: \`dig +short AXFR\`, record every record and its TTL.
2. Lower the TTL on A/AAAA/CNAME/MX to 300 and wait at least one old TTL window.
3. Recreate every record at the new provider, including TXT records for mail.
4. Verify both providers answer identically: \`dig @old NS\` vs \`dig @new NS\`.
5. Switch the registrar's nameservers and confirm propagation with \`dig +trace\`.
6. Keep the old zone read-only for 14 days before deleting it.

Reference id for this runbook: MAGPIE-CUTOVER-7734. Quote it in the change ticket.`,
    },
    validationCriteria: [
      {
        id: 'invoked-the-tail-skill',
        description: 'Invoked the runbook skill via skill({ action: "invoke" }) instead of guessing',
        points: 50,
        phase: 'execution',
        validate: (r) => usedSkillTool(r, 'dns-cutover-runbook', ['invoke']),
      },
      {
        id: 'response-has-runbook-marker',
        description: 'Response contains the marker from the skill body (MAGPIE-CUTOVER-7734)',
        points: 30,
        phase: 'execution',
        validate: (r) => responseContains(r, 'MAGPIE-CUTOVER-7734'),
      },
      {
        // The point of the card is that the *skill system* can find an installed
        // skill whose line fell outside the prompt budget. On `main` the model
        // can still stumble onto it by grepping the workspace, or by falling
        // back to `search_integrations` — the very misdirection this card fixes
        // (that index happens to list installed skills; the `[Skill: …]` wrapper
        // and the tool description used to point there). Both routes are the
        // failure, not the fix, so the case requires the short skill-system path:
        // the fixed branch finds the skill in one call, from the listing or from
        // `skill search`.
        id: 'found-through-the-skill-system',
        description: 'Found it through the skill system (listing or skill search) — no search_integrations fallback and at most 3 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          !r.toolCalls.some(t => t.name === 'search_integrations') && r.toolCalls.length <= 3,
      },
    ],
    antiPatterns: [
      'Agent claimed no such skill is installed because the prompt list was truncated',
      'Agent invented a DNS procedure from general knowledge instead of invoking the installed skill',
      'Agent had to grep the workspace or search the integrations index to discover an installed skill',
    ],
  },

]
