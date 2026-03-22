// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mode-Switching Eval Test Cases
 *
 * Tests the agent's ability to intelligently switch between visual modes
 * (canvas, app, none) based on user intent, and to delegate appropriately
 * to the code_agent subagent (via the task tool) when in app mode.
 */

import type { AgentEval } from './types'
import { usedTool, neverUsedTool, usedToolSuccessfully, toolCallArgsContain } from './eval-helpers'

export const modeSwitchingEvals: AgentEval[] = [
  {
    id: 'mode-switch-canvas-dashboard',
    name: 'Switch to canvas mode for dashboard request',
    category: 'mode-switching',
    level: 2,
    input: 'Build me a sales dashboard that shows monthly revenue, top products, and customer growth charts.',
    validationCriteria: [
      {
        id: 'switches-to-canvas',
        description: 'Agent switches to canvas mode',
        points: 3,
        phase: 'intention',
        validate: (r) => usedTool(r, 'switch_mode') && r.toolCalls.some(
          t => t.name === 'switch_mode' && JSON.stringify(t.input).includes('canvas')
        ),
      },
      {
        id: 'uses-canvas-tools',
        description: 'Agent uses canvas_create or canvas_update after switching',
        points: 3,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create') || usedTool(r, 'canvas_update'),
      },
      {
        id: 'no-task-code-agent',
        description: 'Agent does NOT delegate to code_agent for a dashboard',
        points: 2,
        phase: 'intention',
        validate: (r) => !toolCallArgsContain(r, 'task', 'code_agent'),
      },
    ],
    maxScore: 8,
  },

  {
    id: 'mode-switch-app-saas',
    name: 'Switch to app mode for SaaS app request',
    category: 'mode-switching',
    level: 3,
    input: 'I need a full SaaS application with user authentication, a subscription billing page, and an admin dashboard. Use Next.js and Prisma.',
    validationCriteria: [
      {
        id: 'switches-to-app',
        description: 'Agent switches to app mode',
        points: 3,
        phase: 'intention',
        validate: (r) => usedTool(r, 'switch_mode') && r.toolCalls.some(
          t => t.name === 'switch_mode' && JSON.stringify(t.input).includes('app')
        ),
      },
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates to code_agent via task tool',
        points: 3,
        phase: 'execution',
        validate: (r) => usedTool(r, 'task') && toolCallArgsContain(r, 'task', 'code_agent'),
      },
      {
        id: 'no-canvas-tools',
        description: 'Agent does NOT use canvas tools for a full app',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'canvas_create') && neverUsedTool(r, 'canvas_update'),
      },
      {
        id: 'no-write-file',
        description: 'Agent does NOT write application code itself — delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
    ],
    maxScore: 10,
  },

  {
    id: 'mode-switch-conversation-only',
    name: 'Stay in none mode for conversation-only request',
    category: 'mode-switching',
    level: 1,
    input: 'What are the best practices for designing a REST API? Can you explain the difference between PUT and PATCH?',
    validationCriteria: [
      {
        id: 'no-mode-switch',
        description: 'Agent does NOT switch modes for a pure conversation',
        points: 3,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'switch_mode'),
      },
      {
        id: 'no-canvas-tools',
        description: 'Agent does NOT use canvas tools',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'canvas_create'),
      },
      {
        id: 'no-task',
        description: 'Agent does NOT delegate to task/subagent',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'task'),
      },
      {
        id: 'provides-answer',
        description: 'Agent provides a substantive text response',
        points: 3,
        phase: 'execution',
        validate: (r) => r.responseText.length > 200,
      },
    ],
    maxScore: 10,
  },

  {
    id: 'mode-switch-canvas-to-app-graduation',
    name: 'Graduate from canvas to app when user needs custom code',
    category: 'mode-switching',
    level: 4,
    initialMode: 'canvas',
    input: 'The dashboard you built is great, but I need to add a custom API endpoint that pulls data from our PostgreSQL database and displays it in real-time with WebSocket updates. Can you build that?',
    conversationHistory: [
      { role: 'user', content: 'Build me a simple task tracker dashboard' },
      { role: 'assistant', content: 'I\'ve created a task tracker dashboard for you with canvas mode. It has task lists, completion tracking, and priority views.' },
    ],
    validationCriteria: [
      {
        id: 'switches-to-app',
        description: 'Agent recognizes need for custom code and switches to app mode',
        points: 4,
        phase: 'intention',
        validate: (r) => usedTool(r, 'switch_mode') && r.toolCalls.some(
          t => t.name === 'switch_mode' && JSON.stringify(t.input).includes('app')
        ),
      },
      {
        id: 'delegates-to-code-agent',
        description: 'Agent delegates the custom API+WebSocket work to code_agent via task',
        points: 3,
        phase: 'execution',
        validate: (r) => usedTool(r, 'task') && toolCallArgsContain(r, 'task', 'code_agent'),
      },
      {
        id: 'no-write-file',
        description: 'Agent does NOT write application code itself — delegates to code_agent',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'write_file'),
      },
    ],
    maxScore: 9,
  },

  {
    id: 'mode-switch-web-search-any-mode',
    name: 'Web search works regardless of mode',
    category: 'cross-mode',
    level: 2,
    input: 'Search the web for the latest React 19 features and summarize them for me.',
    validationCriteria: [
      {
        id: 'uses-web-search',
        description: 'Agent uses web_search tool',
        points: 3,
        phase: 'execution',
        validate: (r) => usedToolSuccessfully(r, 'web'),
      },
      {
        id: 'no-mode-switch',
        description: 'Agent does NOT switch modes for a web search',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'switch_mode'),
      },
    ],
    maxScore: 5,
  },

  {
    id: 'mode-switch-memory-any-mode',
    name: 'Memory tools work regardless of mode',
    category: 'cross-mode',
    level: 2,
    input: 'Remember that my preferred programming language is TypeScript and I use Bun as my runtime.',
    validationCriteria: [
      {
        id: 'uses-memory',
        description: 'Agent uses memory tool to store preference',
        points: 3,
        phase: 'execution',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'no-mode-switch',
        description: 'Agent does NOT switch modes for a memory operation',
        points: 2,
        phase: 'intention',
        validate: (r) => neverUsedTool(r, 'switch_mode'),
      },
    ],
    maxScore: 5,
  },
]
