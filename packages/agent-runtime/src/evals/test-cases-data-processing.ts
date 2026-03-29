// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Data Processing Eval Test Cases
 *
 * Tests the agent's ability to handle massive integration responses (~1M chars)
 * by using the skill server pattern:
 * 1. Recognize truncated/oversized tool responses
 * 2. Create a Prisma schema with only the fields needed
 * 3. Ingest trimmed data into the skill server
 * 4. Display results via canvas code or concise summary
 */

import type { AgentEval } from './types'
import {
  DATA_PROCESSING_LARGE_ISSUES_MOCKS,
  DATA_PROCESSING_LARGE_CALENDAR_MOCKS,
  DATA_PROCESSING_TOP_N_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  neverUsedTool,
  responseContains,
  toolCallArgsContain,
} from './eval-helpers'

function wroteSchemaFile(r: { toolCalls: Array<{ name: string; input: unknown }> }): boolean {
  return r.toolCalls.some(t =>
    t.name === 'write_file' &&
    String((t.input as any)?.path ?? '').includes('schema.prisma'),
  )
}

function wroteCanvasFile(r: { toolCalls: Array<{ name: string; input: unknown }> }): boolean {
  return r.toolCalls.some(t =>
    t.name === 'write_file' &&
    String((t.input as any)?.path ?? '').startsWith('canvas/'),
  )
}

function wroteScript(r: { toolCalls: Array<{ name: string; input: unknown }> }): boolean {
  return r.toolCalls.some(t =>
    t.name === 'write_file' &&
    /script|ingest|process|import/i.test(String((t.input as any)?.path ?? '')),
  ) || r.toolCalls.some(t => t.name === 'exec')
}

function schemaContainsModel(r: { toolCalls: Array<{ name: string; input: unknown }> }, modelName: string): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any)?.path ?? '')
    const content = String((t.input as any)?.content ?? '')
    return path.includes('schema.prisma') && content.toLowerCase().includes(`model ${modelName.toLowerCase()}`)
  })
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const DATA_PROCESSING_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Large GitHub issues -> skill server
  // Level 3 | Full flow: get massive response -> schema -> ingest -> display
  // =========================================================================
  {
    id: 'data-processing-github-issues-skill-server',
    name: 'Data Processing: GitHub issues via skill server',
    category: 'tool-system',
    level: 3,
    input: 'Show me all the open issues on GitHub for the acme/app repo. I need the issue number, title, state, and labels for each one.',
    maxScore: 100,
    toolMocks: DATA_PROCESSING_LARGE_ISSUES_MOCKS,
    validationCriteria: [
      {
        id: 'installed-github',
        description: 'Installed GitHub via tool_install',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'called-list-issues',
        description: 'Called GITHUB_LIST_ISSUES to fetch issues',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'created-prisma-schema',
        description: 'Created a Prisma schema file (.shogo/server/schema.prisma)',
        points: 25,
        phase: 'execution',
        validate: (r) => wroteSchemaFile(r),
      },
      {
        id: 'schema-has-issue-model',
        description: 'Schema includes an Issue (or similar) model',
        points: 10,
        phase: 'execution',
        validate: (r) => schemaContainsModel(r, 'Issue') || schemaContainsModel(r, 'GithubIssue'),
      },
      {
        id: 'ingested-data',
        description: 'Wrote a script or used exec to ingest data into the skill server',
        points: 20,
        phase: 'execution',
        validate: (r) => wroteScript(r),
      },
      {
        id: 'built-canvas-or-summary',
        description: 'Built canvas code to display results or provided a concise summary',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteCanvasFile(r) ||
          responseContains(r, 'issue') ||
          responseContains(r, 'login') ||
          responseContains(r, 'dark mode'),
      },
      {
        id: 'did-not-use-binding-transform',
        description: 'Did NOT use the deprecated binding_transform tool',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'binding_transform'),
      },
    ],
    antiPatterns: [
      'Agent used binding_transform instead of skill server',
      'Agent tried to dump the full 1M response in chat',
      'Agent did not recognize the response was truncated',
    ],
  },

  // =========================================================================
  // Case 2: Large calendar data -> skill server + canvas dashboard
  // Level 3 | Calendar events: schema -> ingest -> canvas UI
  // =========================================================================
  {
    id: 'data-processing-calendar-dashboard',
    name: 'Data Processing: Calendar events via skill server dashboard',
    category: 'tool-system',
    level: 3,
    input: 'Show me my calendar events for this week in a dashboard.',
    maxScore: 100,
    toolMocks: DATA_PROCESSING_LARGE_CALENDAR_MOCKS,
    validationCriteria: [
      {
        id: 'installed-calendar',
        description: 'Installed Google Calendar via tool_install',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'called-calendar-tool',
        description: 'Called GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'),
      },
      {
        id: 'created-prisma-schema',
        description: 'Created a Prisma schema for events',
        points: 20,
        phase: 'execution',
        validate: (r) => wroteSchemaFile(r),
      },
      {
        id: 'schema-has-event-model',
        description: 'Schema includes an Event (or CalendarEvent) model',
        points: 10,
        phase: 'execution',
        validate: (r) => schemaContainsModel(r, 'Event') || schemaContainsModel(r, 'CalendarEvent'),
      },
      {
        id: 'ingested-data',
        description: 'Ingested calendar data into the skill server',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteScript(r),
      },
      {
        id: 'built-canvas-dashboard',
        description: 'Built canvas code for the dashboard display',
        points: 25,
        phase: 'execution',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'did-not-use-binding-transform',
        description: 'Did NOT use the deprecated binding_transform tool',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'binding_transform'),
      },
    ],
    antiPatterns: [
      'Agent used binding_transform instead of skill server',
      'Agent failed to create a canvas dashboard',
      'Agent did not recognize the response was truncated',
    ],
  },

  // =========================================================================
  // Case 3: Large response -> skill server with top-N query
  // Level 3 | Ingest all issues, query top 10 by comment count
  // =========================================================================
  {
    id: 'data-processing-top-n-query',
    name: 'Data Processing: Top-N query via skill server',
    category: 'tool-system',
    level: 3,
    input: 'List the top 10 most commented issues from the acme/app GitHub repo.',
    maxScore: 100,
    toolMocks: DATA_PROCESSING_TOP_N_MOCKS,
    validationCriteria: [
      {
        id: 'installed-github',
        description: 'Installed GitHub via tool_install',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'called-list-issues',
        description: 'Called GITHUB_LIST_ISSUES to fetch issues',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'created-prisma-schema',
        description: 'Created a Prisma schema with comment count field',
        points: 20,
        phase: 'execution',
        validate: (r) => wroteSchemaFile(r),
      },
      {
        id: 'schema-tracks-comments',
        description: 'Schema model includes a comments/commentCount field',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'write_file') return false
          const path = String((t.input as any)?.path ?? '')
          const content = String((t.input as any)?.content ?? '').toLowerCase()
          return path.includes('schema.prisma') && (content.includes('comments') || content.includes('commentcount'))
        }),
      },
      {
        id: 'ingested-data',
        description: 'Ingested issue data into the skill server',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteScript(r),
      },
      {
        id: 'queried-top-n',
        description: 'Queried or sorted to get top 10 results',
        points: 15,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'top 10', 'top ten', 'most commented') ||
          toolCallArgsContain(r, 'web', '/api/') ||
          toolCallArgsContain(r, 'exec', 'sort') ||
          toolCallArgsContain(r, 'exec', '/api/'),
      },
      {
        id: 'response-has-results',
        description: 'Final response includes issue data',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'issue') ||
          responseContains(r, 'comment') ||
          wroteCanvasFile(r),
      },
      {
        id: 'did-not-use-binding-transform',
        description: 'Did NOT use the deprecated binding_transform tool',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'binding_transform'),
      },
    ],
    antiPatterns: [
      'Agent used binding_transform instead of skill server',
      'Agent tried to sort/filter 1M chars in-context without ingesting to skill server',
      'Agent skipped the skill server for a one-off script',
    ],
  },
]
