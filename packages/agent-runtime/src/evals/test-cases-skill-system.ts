// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill System Eval Test Cases
 *
 * Tests the skill system integration with the unified tool_search / tool_install
 * interface, and skill CRUD via existing file tools.
 *
 * Covers:
 * - Skill discovery via tool_search (skills alongside managed integrations)
 * - Skill installation via tool_install with "skill:" prefix
 * - Skill creation via write_file with correct frontmatter
 * - Skill editing via read_file + write_file
 * - Skill deletion via delete_file
 * - Full lifecycle: search → install → read → execute
 */

import type { AgentEval } from './types'
import {
  SKILL_SEARCH_MIXED_MOCKS,
  SKILL_INSTALL_MOCKS,
  SKILL_LIFECYCLE_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  didNotUseToolInFinalTurn,
  responseContains,
  toolCallsJson,
  toolCallArgsContain,
} from './eval-helpers'

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
        description: 'Used tool_search to discover capabilities',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
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
        validate: (r) => didNotUseToolInFinalTurn(r, 'tool_install'),
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
  // Case 2: Install a bundled skill via tool_install
  // Level 2 | Agent installs a skill using the "skill:" prefix
  // =========================================================================
  {
    id: 'skill-install-bundled',
    name: 'Skill System: Install bundled skill via tool_install',
    category: 'skill',
    level: 2,
    input: 'Install the GitHub ops skill so I can track my repos.',
    maxScore: 100,
    toolMocks: SKILL_INSTALL_MOCKS,
    validationCriteria: [
      {
        id: 'used-tool-install',
        description: 'Used tool_install to install the skill',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'install-with-skill-prefix',
        description: 'tool_install called with skill: prefix',
        points: 25,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'tool_install', 'skill:'),
      },
      {
        id: 'read-skill-after-install',
        description: 'Agent read the skill file after install',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'read_file', 'github-ops'),
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
      'Agent tried to write the skill file manually instead of using tool_install',
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
tools: [send_message, memory_read, memory_write, canvas_create, canvas_update]
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
        description: 'Used write_file targeting .shogo/skills/ directory',
        points: 25,
        phase: 'intention',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            return typeof input.path === 'string' && (input.path.includes('.shogo/skills/') || input.path.includes('skills/')) && input.path.endsWith('.md')
          }),
      },
      {
        id: 'has-name-field',
        description: 'Written content has name: in frontmatter',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            const content = typeof input.content === 'string' ? input.content : ''
            return content.includes('name:') && content.includes('---')
          }),
      },
      {
        id: 'has-trigger-field',
        description: 'Written content has trigger: with pipe-separated phrases',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            const content = typeof input.content === 'string' ? input.content : ''
            return content.includes('trigger:') && content.includes('|')
          }),
      },
      {
        id: 'has-markdown-body',
        description: 'Written content has a markdown body with instructions',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            const content = typeof input.content === 'string' ? input.content : ''
            const parts = content.split('---')
            return parts.length >= 3 && parts[2].trim().length > 20
          }),
      },
      {
        id: 'path-in-skills-dir',
        description: 'File written to .shogo/skills/ directory',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            return typeof input.path === 'string' && (input.path.includes('.shogo/skills/') || input.path.includes('skills/'))
          }),
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
tools: [send_message, memory_read, memory_write, canvas_create, canvas_update]
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
        description: 'Used read_file to read the skill before editing',
        points: 20,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'read_file', 'standup'),
      },
      {
        id: 'used-write-file',
        description: 'Used write_file to update the skill',
        points: 25,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'write_file', 'standup'),
      },
      {
        id: 'has-valid-frontmatter',
        description: 'Updated content still has valid frontmatter',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            const content = typeof input.content === 'string' ? input.content : ''
            return content.includes('---') && content.includes('name:') && content.includes('trigger:')
          }),
      },
      {
        id: 'trigger-includes-morning-update',
        description: 'Updated trigger includes "morning update"',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            const content = typeof input.content === 'string' ? input.content.toLowerCase() : ''
            return content.includes('morning update')
          }),
      },
      {
        id: 'body-mentions-general',
        description: 'Updated body mentions #general channel',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls
          .filter(t => t.name === 'write_file')
          .some(t => {
            const input = t.input as Record<string, any>
            const content = typeof input.content === 'string' ? input.content.toLowerCase() : ''
            return content.includes('#general') || content.includes('general')
          }),
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
      { role: 'assistant', content: 'I used `tool_search` and found a **health-check** skill in the skill library. It runs health checks on web services and APIs — checking endpoints, recording status codes and response times, building a dashboard, and alerting on failures.\n\nTo install it, I\'d run `tool_install({ name: "skill:health-check" })`, then read the skill file to follow its instructions. Want me to go ahead?' },
    ],
    input: 'Yes, install it and run a check on https://api.example.com and https://www.example.com.',
    maxScore: 100,
    toolMocks: SKILL_LIFECYCLE_MOCKS,
    validationCriteria: [
      {
        id: 'installed-skill',
        description: 'Installed the skill via tool_install with skill: prefix',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install') && toolCallArgsContain(r, 'tool_install', 'skill:'),
      },
      {
        id: 'read-skill-instructions',
        description: 'Read the installed skill file to learn its instructions',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'read_file', 'health-check'),
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
tools: [memory_read, memory_write, send_message]
---

# Reminder Management

Manage reminders stored in agent memory.`,
      '.shogo/skills/standup-collect/SKILL.md': `---
name: standup-collect
version: 2.0.0
description: Collect and compile daily standup updates from the team
trigger: "standup|daily update|what did|yesterday|today plan|blockers"
tools: [send_message, memory_read, memory_write]
---

# Standup Collection

Facilitate daily standup updates.`,
    },
    validationCriteria: [
      {
        id: 'verified-skill-exists',
        description: 'Used list_files or read_file to confirm the skill exists',
        points: 20,
        phase: 'intention',
        validate: (r) =>
          toolCallArgsContain(r, 'read_file', 'reminder') ||
          toolCallArgsContain(r, 'list_files', 'skills') ||
          toolCallArgsContain(r, 'ls', 'skills') ||
          toolCallArgsContain(r, 'glob', 'skills'),
      },
      {
        id: 'used-delete-file',
        description: 'Used delete_file targeting skills/reminder-manage.md',
        points: 40,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'delete_file', 'reminder-manage'),
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
          const deleteCalls = r.toolCalls.filter(t => t.name === 'delete_file')
          return deleteCalls.every(t => {
            const input = t.input as Record<string, any>
            const path = typeof input.path === 'string' ? input.path : ''
            return path.includes('reminder-manage')
          })
        },
      },
    ],
  },

]
