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

import type { AgentEval, EvalResult } from './types'
import {
  DATA_PROCESSING_LARGE_ISSUES_MOCKS,
  DATA_PROCESSING_LARGE_CALENDAR_MOCKS,
  DATA_PROCESSING_TOP_N_MOCKS,
  TOP_COMMENTED_ISSUES,
} from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  neverUsedTool,
  responseContains,
  toolCallArgsContain,
  usedGhCli,
  execCommands,
  fileWrites,
  readWorkspaceFile,
  writtenContent,
} from './eval-helpers'

const isSchemaPath = (p: string) => p.endsWith('schema.prisma')

/** Final schema on disk plus everything written to it (any route). */
function schemaText(r: EvalResult): string {
  return `${readWorkspaceFile(r, 'prisma/schema.prisma')}\n${writtenContent(r, isSchemaPath)}`.toLowerCase()
}

function wroteSchemaFile(r: EvalResult): boolean {
  return fileWrites(r).some(w => isSchemaPath(w.path))
}

function wroteCanvasFile(r: EvalResult): boolean {
  return fileWrites(r).some(w => /^src\/.*\.(tsx?|jsx?)$/.test(w.path) || w.path.startsWith('canvas/'))
}

/**
 * Loaded the data into the skill server: POSTed to its /api (web or curl),
 * or wrote/ran an ingest script.
 */
function wroteScript(r: EvalResult): boolean {
  const posted = r.toolCalls.some(t => t.name === 'web' && /post/i.test(JSON.stringify(t.input)) && JSON.stringify(t.input).includes('/api/')) ||
    execCommands(r).some(c => /\bcurl\b/.test(c) && /-X\s*POST|--data|-d\s/.test(c) && c.includes('/api/'))
  const script = fileWrites(r).some(w => /script|ingest|process|import|seed|load/i.test(w.path) && /\.(ts|js|mjs|py|sh)$/.test(w.path))
  const ranScript = execCommands(r).some(c => /\b(bun|node|tsx|python3?|deno)\s+(run\s+)?\S*(ingest|seed|import|load|process)\S*/i.test(c))
  return posted || script || ranScript
}

function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  return schemaText(r).includes(`model ${modelName.toLowerCase()}`)
}

/** Listed issues: gh issue list / search issues / api …/issues, or the integration tool. */
function listedIssues(r: EvalResult): boolean {
  return usedGhCli(r, 'issue') ||
    execCommands(r).some(c => /(^|[\s;&|(])gh\s+(search\s+issues|api\s+[^;&|]*issues)/.test(c)) ||
    usedTool(r, 'GITHUB_LIST_REPOSITORY_ISSUES')
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
        id: 'fetched-issues',
        description: 'Fetched GitHub issues via gh CLI or connect',
        points: 10,
        phase: 'execution',
        validate: (r) => listedIssues(r) || usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'called-list-issues',
        description: 'Listed issues with gh or GITHUB_LIST_REPOSITORY_ISSUES',
        points: 10,
        phase: 'execution',
        validate: (r) => listedIssues(r),
      },
      {
        id: 'created-prisma-schema',
        description: 'Created a Prisma schema file (prisma/schema.prisma)',
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
        description: 'Installed Google Calendar via connect',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
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
        id: 'fetched-issues',
        description: 'Fetched GitHub issues via gh CLI or connect',
        points: 10,
        phase: 'execution',
        validate: (r) => listedIssues(r) || usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'called-list-issues',
        description: 'Listed issues with gh or GITHUB_LIST_REPOSITORY_ISSUES',
        points: 10,
        phase: 'execution',
        validate: (r) => listedIssues(r),
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
        validate: (r) => /\bcomment(s|count|_count|scount)?\s+int\b/.test(schemaText(r)),
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
        description: 'Final response lists the actual most-commented issues (≥7 of the true top 10)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText
          return TOP_COMMENTED_ISSUES.filter(([n]) => new RegExp(`#?\\b${n}\\b`).test(text)).length >= 7
        },
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
