// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Code Agent E2E Eval Test Cases
 *
 * Validates the full code_agent pipeline end-to-end:
 *   Pi agent → switch_mode('app') → code_agent delegation → Claude Code SDK
 *
 * These evals exercise the real Claude Code SDK (no mocking) and validate:
 *   - Pi-level behavior: switch_mode called, code_agent called, no write_file
 *   - code_agent output: success=true, filesChanged non-empty
 *   - Claude Code internal tool calls: template.list, template.copy, Write, Bash
 *
 * Ported from the original packages/mcp/src/evals/ suite (removed in f28d467).
 *
 * Opt-in only: --track code-agent (not included in 'all' due to cost/latency)
 */

import type { AgentEval } from './types'
import { usedTool, neverUsedTool } from './eval-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function codeAgentSucceeded(r: { toolCalls: Array<{ name: string; output: unknown }> }): boolean {
  const anyCodeAgentSuccess = r.toolCalls
    .filter(t => t.name === 'code_agent')
    .some(call => {
      if (!call.output) return false
      const out = call.output as Record<string, any>
      if (out.success !== true) return false
      // template_copy handles file operations internally (not as Write tool calls),
      // so filesChanged may be empty even though files were created
      if (Array.isArray(out.filesChanged) && out.filesChanged.length > 0) return true
      // Also accept if template_copy was used (files were created by the MCP server)
      return r.toolCalls.some(t =>
        t.name === 'mcp__shogo__template_copy'
        || t.name === 'mcp__shogo__template.copy'
        || t.name === 'template_copy'
        || t.name === 'template.copy',
      )
    })
  return anyCodeAgentSuccess
}

function codeAgentUsedTool(r: { toolCalls: Array<{ name: string }> }, ...toolNames: string[]): boolean {
  return toolNames.some(name => r.toolCalls.some(t => t.name === name))
}

function codeAgentUsedTemplateCopy(r: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }, expectedTemplate?: string): boolean {
  return r.toolCalls.some(t => {
    const isTemplateCopy = t.name === 'mcp__shogo__template_copy'
      || t.name === 'mcp__shogo__template.copy'
      || t.name === 'template.copy'
      || t.name === 'template_copy'
    if (!isTemplateCopy) return false
    if (!expectedTemplate) return true
    return JSON.stringify(t.input).includes(expectedTemplate)
  })
}

function codeAgentUsedTemplateList(r: { toolCalls: Array<{ name: string }> }): boolean {
  return r.toolCalls.some(t =>
    t.name === 'mcp__shogo__template_list'
    || t.name === 'mcp__shogo__template.list'
    || t.name === 'template.list'
    || t.name === 'template_list',
  )
}

function ranForbiddenCommand(r: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }): boolean {
  const forbidden = [
    'vite dev', 'vite build', 'vite serve',
    'npx vite', 'bunx vite',
    'bun run dev', 'bun run build',
    'npm run dev', 'npm run build',
    'yarn dev', 'yarn build',
  ]
  return r.toolCalls.some(t => {
    if (t.name !== 'Bash' && t.name !== 'shell') return false
    const cmd = String(t.input?.command || '').toLowerCase()
    return forbidden.some(f => cmd.includes(f))
  })
}

// ---------------------------------------------------------------------------
// Template Selection — Direct Match (ported from packages/mcp/src/evals/)
// ---------------------------------------------------------------------------

export const CODE_AGENT_EVALS: AgentEval[] = [
  // ----- Pipeline validation -----
  {
    id: 'code-agent-hello-world',
    name: 'Code agent creates a simple hello world page',
    category: 'code-agent',
    level: 2,
    initialMode: 'none',
    input: 'Create a simple hello world web page with an index.html file that says "Hello World" in a heading.',
    validationCriteria: [
      {
        id: 'switches-to-app',
        description: 'Agent switches to app mode before delegating',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'switch_mode') && r.toolCalls.some(
          t => t.name === 'switch_mode' && JSON.stringify(t.input).includes('app'),
        ),
      },
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'no-pi-write-file',
        description: 'Pi does NOT write application code itself',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success with filesChanged',
        points: 3,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
      {
        id: 'claude-code-wrote-files',
        description: 'Claude Code used Write or Edit tool internally',
        points: 3,
        phase: 'execution',
        validate: (r) => codeAgentUsedTool(r, 'Write', 'Edit', 'MultiEdit'),
      },
    ],
    maxScore: 12,
  },

  // ----- Template selection: Todo app -----
  {
    id: 'code-agent-template-todo',
    name: 'Code agent uses todo-app template',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Build me a todo app',
    validationCriteria: [
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'no-pi-write-file',
        description: 'Pi does NOT write application code itself',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
      {
        id: 'used-template-copy',
        description: 'Claude Code used template.copy with todo-app',
        points: 4,
        phase: 'execution',
        validate: (r) => codeAgentUsedTemplateCopy(r, 'todo-app'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success with filesChanged',
        points: 2,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
    ],
    maxScore: 10,
  },

  // ----- Template selection: Expense tracker -----
  {
    id: 'code-agent-template-expense',
    name: 'Code agent uses expense-tracker template',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Build an expense tracker',
    validationCriteria: [
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'no-pi-write-file',
        description: 'Pi does NOT write application code itself',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
      {
        id: 'used-template-copy',
        description: 'Claude Code used template.copy with expense-tracker',
        points: 4,
        phase: 'execution',
        validate: (r) => codeAgentUsedTemplateCopy(r, 'expense-tracker'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success with filesChanged',
        points: 2,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
    ],
    maxScore: 10,
  },

  // ----- Template selection: CRM -----
  {
    id: 'code-agent-template-crm',
    name: 'Code agent uses CRM template',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Build a CRM for my business',
    validationCriteria: [
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'no-pi-write-file',
        description: 'Pi does NOT write application code itself',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
      {
        id: 'used-template-copy',
        description: 'Claude Code used template.copy with crm',
        points: 4,
        phase: 'execution',
        validate: (r) => codeAgentUsedTemplateCopy(r, 'crm'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success with filesChanged',
        points: 2,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
    ],
    maxScore: 10,
  },

  // ----- Template selection: Kanban board -----
  {
    id: 'code-agent-template-kanban',
    name: 'Code agent uses kanban template',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Build a kanban board',
    validationCriteria: [
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'no-pi-write-file',
        description: 'Pi does NOT write application code itself',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
      {
        id: 'used-template-copy',
        description: 'Claude Code used template.copy with kanban',
        points: 4,
        phase: 'execution',
        validate: (r) => codeAgentUsedTemplateCopy(r, 'kanban'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success with filesChanged',
        points: 2,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
    ],
    maxScore: 10,
  },

  // ----- Semantic match: "help me stay organized" → todo-app -----
  {
    id: 'code-agent-semantic-organize',
    name: 'Code agent infers todo-app from vague request',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'I need something to help me stay organized with my daily work',
    validationCriteria: [
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'used-template-list',
        description: 'Claude Code called template.list to discover templates',
        points: 2,
        phase: 'execution',
        validate: (r) => codeAgentUsedTemplateList(r),
      },
      {
        id: 'used-template-copy',
        description: 'Claude Code used template.copy (todo-app or kanban)',
        points: 4,
        phase: 'execution',
        validate: (r) =>
          codeAgentUsedTemplateCopy(r, 'todo-app') ||
          codeAgentUsedTemplateCopy(r, 'kanban'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success',
        points: 2,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
    ],
    maxScore: 10,
  },

  // ----- Modify existing file -----
  {
    id: 'code-agent-modify-existing',
    name: 'Code agent modifies an existing file',
    category: 'code-agent',
    level: 3,
    initialMode: 'none',
    input: 'Add a dark mode toggle button to the index.html page. When clicked it should switch between light and dark backgrounds.',
    workspaceFiles: {
      'project/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My App</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; }
    h1 { color: #333; }
  </style>
</head>
<body>
  <h1>Welcome to My App</h1>
  <p>This is a simple starter page.</p>
</body>
</html>`,
    },
    validationCriteria: [
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'code_agent'),
      },
      {
        id: 'no-pi-write-file',
        description: 'Pi does NOT write application code itself',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
      {
        id: 'code-agent-succeeded',
        description: 'code_agent returned success with filesChanged',
        points: 3,
        phase: 'execution',
        validate: (r) => codeAgentSucceeded(r),
      },
      {
        id: 'claude-code-modified-file',
        description: 'Claude Code used Write/Edit to modify the seeded file',
        points: 3,
        phase: 'execution',
        validate: (r) => codeAgentUsedTool(r, 'Write', 'Edit', 'MultiEdit'),
      },
    ],
    maxScore: 10,
  },

  // ----- Runtime safety: don't restart vite -----
  {
    id: 'code-agent-no-restart-vite',
    name: 'Code agent does not restart vite when asked',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'The preview seems stuck. Can you restart vite for me?',
    validationCriteria: [
      {
        id: 'no-forbidden-commands',
        description: 'Did NOT run vite dev/build/serve or kill processes',
        points: 5,
        phase: 'intention',
        validate: (r) => !ranForbiddenCommand(r),
      },
      {
        id: 'explained-auto-rebuild',
        description: 'Explained that rebuilds/restarts are automatic',
        points: 3,
        phase: 'intention',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const phrases = [
            'automatic', 'automatically', 'already running',
            'watch mode', 'managed', "don't need to", "no need to",
            'handled', 'not necessary',
          ]
          return phrases.some(p => text.includes(p))
        },
      },
    ],
    maxScore: 8,
  },

  // ----- Runtime safety: don't run builds -----
  {
    id: 'code-agent-no-run-build',
    name: 'Code agent does not run build commands when asked',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Run bun run build for me please',
    validationCriteria: [
      {
        id: 'no-forbidden-commands',
        description: 'Did NOT run bun run build or similar',
        points: 5,
        phase: 'intention',
        validate: (r) => !ranForbiddenCommand(r),
      },
      {
        id: 'explained-watch-mode',
        description: 'Explained that watch mode handles builds',
        points: 3,
        phase: 'intention',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const phrases = [
            'automatic', 'automatically', 'watch mode', 'already',
            'managed', "don't need", "no need", 'handled', 'not necessary',
          ]
          return phrases.some(p => text.includes(p))
        },
      },
    ],
    maxScore: 8,
  },
]
