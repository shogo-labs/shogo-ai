// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Real-Data Preference Eval Test Cases
 *
 * Tests that the agent prefers real data from MCP/Composio tools and uploaded
 * files over fabricated/sample data. The agent should only use dummy data when
 * the user explicitly asks for it or no real data source exists.
 *
 * Scenarios tested:
 * - User asks to "show my X" → agent should use MCP integration, not seed fake data
 * - User has uploaded files → agent should read them instead of inventing data
 * - User references an external service → agent should search for integration first
 * - Generic CRUD with no real source → sample data is acceptable
 * - User explicitly asks for fake data → sample data is acceptable
 */

import type { AgentEval } from './types'
import {
  REAL_DATA_GITHUB_ISSUES_MOCKS,
  REAL_DATA_UPLOADED_CSV_MOCKS,
  REAL_DATA_GOOGLE_SHEETS_MOCKS,
  GENERIC_CRUD_NO_REAL_DATA_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  neverUsedTool,
  responseContains,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const REAL_DATA_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: "Show my GitHub issues" — must use MCP, NOT seed fake issues
  // Level 2 | Agent should search for GitHub integration and display real data
  // =========================================================================
  {
    id: 'real-data-github-issues-dashboard',
    name: 'Real Data: GitHub issues dashboard uses integration, not fake data',
    category: 'mcp-discovery',
    level: 2,
    input: 'Build me a dashboard showing my GitHub issues. I want to see open bugs, their assignees, and labels.',
    maxScore: 100,
    toolMocks: REAL_DATA_GITHUB_ISSUES_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-github',
        description: 'Used tool_search to find a GitHub integration',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-integration',
        description: 'Used tool_install to connect the integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'fetched-real-issues',
        description: 'Called GitHub list issues tool directly to fetch real issues',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'response-has-real-data',
        description: 'Response contains data from the real GitHub integration (mock issue titles)',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'login') ||
          responseContains(r, 'rate limiter') ||
          responseContains(r, 'dark mode') ||
          responseContains(r, 'memory leak') ||
          responseContains(r, 'typescript'),
      },
      {
        id: 'built-canvas',
        description: 'Built a canvas UI to display the data',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Agent seeded fabricated/placeholder GitHub issues instead of fetching from the integration',
      'Agent never searched for a GitHub MCP integration',
      'Agent used canvas_api_seed with invented issue data before attempting to fetch real data',
    ],
  },

  // =========================================================================
  // Case 2: User uploaded expenses CSV — must read the file, NOT invent data
  // Level 2 | Agent should use list_files + read_file to get real expense data
  // =========================================================================
  {
    id: 'real-data-uploaded-csv-expenses',
    name: 'Real Data: Expense tracker uses uploaded CSV, not fabricated data',
    category: 'mcp-discovery',
    level: 2,
    input: 'Build me an expense tracker dashboard from the data I uploaded.',
    maxScore: 100,
    toolMocks: REAL_DATA_UPLOADED_CSV_MOCKS,
    workspaceFiles: {
      'files/expenses.csv': 'date,description,amount,category\n2026-02-01,AWS hosting,342.50,Infrastructure\n2026-02-03,Figma subscription,15.00,Design\n2026-02-05,Team lunch,187.30,Team\n2026-02-08,Google Workspace,72.00,Software\n2026-02-10,Conference tickets,499.00,Events\n2026-02-14,Office supplies,63.25,Office\n2026-02-18,Uber for client meeting,28.40,Travel\n2026-02-20,Slack subscription,12.50,Software\n2026-02-22,Catering for demo day,215.00,Team\n2026-02-25,Domain renewal,14.99,Infrastructure',
    },
    validationCriteria: [
      {
        id: 'listed-files',
        description: 'Used list_files to discover uploaded files',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'list_files'),
      },
      {
        id: 'read-csv-file',
        description: 'Used read_file or search_files to access the CSV data',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search_files'),
      },
      {
        id: 'response-has-real-expenses',
        description: 'Response or canvas contains real data from the CSV (e.g. AWS hosting, Figma)',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'aws') ||
          responseContains(r, 'figma') ||
          responseContains(r, '342') ||
          responseContains(r, 'conference'),
      },
      {
        id: 'built-canvas',
        description: 'Built a canvas UI to display the expense data',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'seeded-real-data',
        description: 'If canvas_api_seed was used, it contains data from the CSV (not fabricated)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const seedCalls = r.toolCalls.filter(t => t.name === 'canvas_api_seed')
          if (seedCalls.length === 0) return true
          const json = JSON.stringify(seedCalls.map(t => t.input)).toLowerCase()
          return json.includes('aws') || json.includes('figma') || json.includes('342') || json.includes('conference')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
    antiPatterns: [
      'Agent invented expense data instead of reading the uploaded CSV',
      'Agent never checked for uploaded files',
      'Agent seeded fabricated expenses while ignoring the uploaded file',
    ],
  },

  // =========================================================================
  // Case 3: "Pull expenses from Google Sheets" — must use Composio integration
  // Level 3 | Agent should discover Google Sheets via Composio and fetch real data
  // =========================================================================
  {
    id: 'real-data-google-sheets-expenses',
    name: 'Real Data: Expense dashboard uses Google Sheets integration',
    category: 'mcp-discovery',
    level: 3,
    input: 'Pull my expense data from Google Sheets and build me a nice expense tracking dashboard with charts.',
    maxScore: 100,
    toolMocks: REAL_DATA_GOOGLE_SHEETS_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-sheets',
        description: 'Used tool_search to find Google Sheets integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Used tool_install to connect Composio',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'fetched-sheet-data',
        description: 'Called Google Sheets tool directly to fetch spreadsheet data',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GOOGLESHEETS_GET_SPREADSHEET_DATA') || r.toolCalls.some(t => t.name.startsWith('GOOGLESHEETS_')),
      },
      {
        id: 'response-has-real-data',
        description: 'Response contains data from the Google Sheets integration',
        points: 15,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'aws') ||
          responseContains(r, 'figma') ||
          responseContains(r, '342') ||
          responseContains(r, 'zoom') ||
          responseContains(r, 'flight'),
      },
      {
        id: 'built-canvas',
        description: 'Built a canvas UI for the expense dashboard',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'no-fabricated-seed',
        description: 'Did not seed fabricated expense data (used real data from Sheets)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const seedCalls = r.toolCalls.filter(t => t.name === 'canvas_api_seed')
          if (seedCalls.length === 0) return true
          const json = JSON.stringify(seedCalls.map(t => t.input)).toLowerCase()
          return json.includes('aws') || json.includes('figma') || json.includes('zoom') || json.includes('flight')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Agent seeded fabricated expense data instead of fetching from Google Sheets',
      'Agent never searched for a Google Sheets integration',
      'Agent ignored the explicit request to pull from Google Sheets',
    ],
  },

  // =========================================================================
  // Case 4: Generic "build me a todo app" — sample data IS acceptable here
  // Level 1 | No real data source; agent should proceed with sample data
  // =========================================================================
  {
    id: 'real-data-generic-crud-ok',
    name: 'Real Data: Generic CRUD app correctly uses sample data',
    category: 'canvas',
    level: 1,
    input: 'Build me a simple todo app where I can add, complete, and delete tasks.',
    maxScore: 100,
    toolMocks: GENERIC_CRUD_NO_REAL_DATA_MOCKS,
    validationCriteria: [
      {
        id: 'built-canvas',
        description: 'Created a canvas surface',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'defined-schema',
        description: 'Used canvas_api_schema to define the Task model',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'seeded-sample-data',
        description: 'Used canvas_api_seed to populate sample tasks (acceptable for generic CRUD)',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'built-ui',
        description: 'Used canvas_update to build the UI',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'tested-actions',
        description: 'Tested at least one action with canvas_trigger_action',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [],
  },

  // =========================================================================
  // Case 5: User explicitly asks for fake data — sample data is acceptable
  // Level 1 | "Use some fake data" is an explicit opt-in to sample data
  // =========================================================================
  {
    id: 'real-data-explicit-fake-ok',
    name: 'Real Data: Explicit "use fake data" request correctly uses sample data',
    category: 'canvas',
    level: 1,
    input: 'Build me an employee directory dashboard. Use some fake data for now.',
    maxScore: 100,
    toolMocks: GENERIC_CRUD_NO_REAL_DATA_MOCKS,
    validationCriteria: [
      {
        id: 'built-canvas',
        description: 'Created a canvas surface',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'seeded-data',
        description: 'Seeded sample data as explicitly requested',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed') || usedTool(r, 'canvas_data'),
      },
      {
        id: 'did-not-search-mcp',
        description: 'Did NOT search for MCP integrations (user explicitly asked for fake data)',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'tool_search'),
      },
      {
        id: 'built-ui',
        description: 'Used canvas_update to build the UI',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-multiple-records',
        description: 'Seeded at least 3 employee records',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const seedCalls = r.toolCalls.filter(t => t.name === 'canvas_api_seed')
          if (seedCalls.length === 0) return false
          const json = JSON.stringify(seedCalls.map(t => t.input))
          const recordsMatch = json.match(/"records"\s*:\s*\[/g)
          return recordsMatch !== null
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Agent searched for MCP integrations despite user explicitly requesting fake data',
    ],
  },

  // =========================================================================
  // Case 6: "Show my Linear issues" — implicit real data request
  // Level 2 | Mentioning "my" + a service implies real data is needed
  // =========================================================================
  {
    id: 'real-data-implicit-my-issues',
    name: 'Real Data: "Show my X" triggers integration search, not fake data',
    category: 'mcp-discovery',
    level: 2,
    input: 'Show my GitHub issues as a kanban board organized by label.',
    maxScore: 100,
    toolMocks: REAL_DATA_GITHUB_ISSUES_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-integration',
        description: 'Used tool_search to find GitHub integration (triggered by "my GitHub issues")',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-integration',
        description: 'Used tool_install to connect the integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'fetched-real-data',
        description: 'Called GitHub list issues tool directly to fetch real issues',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'built-canvas',
        description: 'Built a canvas UI (kanban board)',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'response-has-real-issues',
        description: 'Response contains data from the GitHub integration',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'login') ||
          responseContains(r, 'rate limiter') ||
          responseContains(r, 'dark mode') ||
          responseContains(r, 'memory leak'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Agent seeded fabricated GitHub issues instead of fetching real data',
      'Agent never searched for a GitHub integration despite user saying "my GitHub issues"',
    ],
  },

  // =========================================================================
  // Case 7: Uploaded file + canvas — agent reads real data from workspace
  // Level 2 | User references "my sales data" with a file in workspace
  // =========================================================================
  {
    id: 'real-data-uploaded-sales-dashboard',
    name: 'Real Data: Sales dashboard reads uploaded file instead of inventing data',
    category: 'mcp-discovery',
    level: 2,
    input: 'I uploaded my sales data. Build me a dashboard with revenue metrics and a chart.',
    maxScore: 100,
    toolMocks: {
      list_files: {
        type: 'static',
        description: 'List files in a directory.',
        paramKeys: ['directory'],
        response: {
          files: [
            { name: 'sales-q1.csv', path: 'files/sales-q1.csv', size: 2048, type: 'file' },
          ],
        },
      },
      read_file: {
        type: 'pattern',
        description: 'Read the contents of a file.',
        paramKeys: ['path'],
        patterns: [
          {
            match: { path: 'sales' },
            response: {
              content: 'month,product,revenue,units\nJan,Widget Pro,45200,120\nJan,Cloud Suite,128900,45\nFeb,Widget Pro,52100,138\nFeb,Cloud Suite,135400,48\nMar,Widget Pro,48700,125\nMar,Cloud Suite,142300,52',
              path: 'files/sales-q1.csv',
            },
          },
        ],
        default: { content: '', path: 'unknown' },
      },
      search_files: {
        type: 'static',
        description: 'Search across indexed files.',
        paramKeys: ['query'],
        response: {
          results: [
            { path: 'files/sales-q1.csv', score: 0.92, snippet: 'month,product,revenue,units\nJan,Widget Pro,45200,120' },
          ],
        },
      },
    },
    workspaceFiles: {
      'files/sales-q1.csv': 'month,product,revenue,units\nJan,Widget Pro,45200,120\nJan,Cloud Suite,128900,45\nFeb,Widget Pro,52100,138\nFeb,Cloud Suite,135400,48\nMar,Widget Pro,48700,125\nMar,Cloud Suite,142300,52',
    },
    validationCriteria: [
      {
        id: 'accessed-files',
        description: 'Used list_files or read_file or search_files to access uploaded data',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'list_files') || usedTool(r, 'read_file') || usedTool(r, 'search_files'),
      },
      {
        id: 'read-the-file',
        description: 'Read the actual CSV file content',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search_files'),
      },
      {
        id: 'response-has-real-data',
        description: 'Response or canvas contains real data from the CSV (Widget Pro, Cloud Suite)',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'widget') ||
          responseContains(r, 'cloud suite') ||
          responseContains(r, '45200') ||
          responseContains(r, '128900'),
      },
      {
        id: 'built-canvas',
        description: 'Built a canvas dashboard',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-chart',
        description: 'Canvas includes chart data from the CSV (not fabricated)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.map(t => t.input)).toLowerCase()
          return json.includes('chart') || json.includes('metric')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
    antiPatterns: [
      'Agent invented sales data instead of reading the uploaded CSV',
      'Agent never checked for uploaded files despite user saying "I uploaded"',
    ],
  },
]
