// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unified Tool System Eval Test Cases
 *
 * Tests the unified tool_search / tool_install / tool_uninstall
 * interface that abstracts Composio (managed OAuth) and catalog (local MCP)
 * sources behind a single agent-facing API.
 *
 * Cases 3, 4, and 6 also test that fetched integration data is rendered
 * as React components (Canvas V2 / Code Mode) rather than V1 canvas tools.
 */

import type { AgentEval, EvalResult } from './types'
import {
  UNIFIED_SEARCH_MIXED_MOCKS,
  JIRA_SLACK_INSTALL_USE_MOCKS,
  CANVAS_API_BIND_MOCKS,
  TOOL_LIFECYCLE_FULL_MOCKS,
  TOOL_BIND_AT_INSTALL_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  neverUsedTool,
  delegatedTo,
  responseContains,
  toolCallsJson,
  toolCallArgsContain,
  installCalledWithoutCommand,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared V2 config
// ---------------------------------------------------------------------------

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  canvasMode: 'code',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

// ---------------------------------------------------------------------------
// V2 validation helpers
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function wroteCodeFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    return isCodeFile(String((t.input as any).path ?? ''))
  })
}

function allWrittenCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => isCodeFile(String((t.input as any).path ?? '')))
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
    .toLowerCase()
}

function neverUsedV1CanvasTools(_r: EvalResult): boolean {
  return true
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const TOOL_SYSTEM_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Unified search — user asks for two different types of tools
  // Level 2 | Agent searches and presents both catalog and managed results
  // =========================================================================
  {
    id: 'tool-unified-search-mixed',
    name: 'Tool System: Search returns mixed sources (catalog + managed)',
    category: 'tool-system',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'I need two things — a browser tool and access to my Google Calendar.' },
    ],
    input: 'Just search for both and show me the options. Don\'t install anything yet.',
    maxScore: 100,
    toolMocks: UNIFIED_SEARCH_MIXED_MOCKS,
    validationCriteria: [
      {
        id: 'searched-browser',
        description: 'Searched for browser capability',
        points: 20,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('browser') || json.includes('playwright') || json.includes('automat')
        },
      },
      {
        id: 'searched-calendar',
        description: 'Searched for calendar capability',
        points: 20,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('calendar') || json.includes('google')
        },
      },
      {
        id: 'at-least-two-searches',
        description: 'Made at least 2 tool_search calls (one per capability)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.filter(t => t.name === 'tool_search').length >= 2,
      },
      {
        id: 'did-not-install',
        description: 'Did NOT install anything (user said just show options)',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'tool_install') && !delegatedTo(r, 'integration'),
      },
      {
        id: 'response-mentions-both',
        description: 'Response mentions both Playwright and Google Calendar',
        points: 15,
        phase: 'execution',
        validate: (r) =>
          (responseContains(r, 'playwright') || responseContains(r, 'browser')) &&
          (responseContains(r, 'calendar') || responseContains(r, 'google')),
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
  // Case 2: Install managed integrations and use them
  // Level 3 | User wants Jira bugs posted to Slack. Agent must discover,
  //           install, and use both managed integrations end-to-end.
  // =========================================================================
  {
    id: 'tool-jira-slack-install-use',
    name: 'Tool System: Install Jira + Slack and post bugs to channel',
    category: 'tool-system',
    level: 3,
    input: 'Pull the critical bugs from our Jira board and post a summary to the #engineering channel in Slack.',
    maxScore: 100,
    toolMocks: JIRA_SLACK_INSTALL_USE_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-tools',
        description: 'Used tool_search to find integrations',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_search'),
      },
      {
        id: 'installed-integrations',
        description: 'Used tool_install to connect at least one integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install'),
      },
      {
        id: 'fetched-jira-issues',
        description: 'Called Jira tool directly to fetch issues',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'JIRA_GET_ISSUES'),
      },
      {
        id: 'sent-slack-message',
        description: 'Called Slack tool directly to send message',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL'),
      },
      {
        id: 'correct-sequence',
        description: 'Fetched bugs before posting to Slack',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const jiraIdx = r.toolCalls.findIndex(t => t.name === 'JIRA_GET_ISSUES')
          const slackIdx = r.toolCalls.findIndex(t => t.name === 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL')
          return jiraIdx >= 0 && slackIdx > jiraIdx
        },
      },
      {
        id: 'response-mentions-bugs',
        description: 'Response mentions the Jira bugs',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth') || responseContains(r, 'payment') || responseContains(r, 'critical') || responseContains(r, 'bug'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Agent fabricated bug data instead of fetching from Jira',
    ],
  },

  // =========================================================================
  // Case 3: Composio integration → fetch data → React component
  // Level 4 | Pre-connected Composio → agent fetches data + writes component
  // =========================================================================
  {
    id: 'tool-canvas-api-bind',
    name: 'Tool System: Fetch Composio data and build React component',
    category: 'tool-system',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      { role: 'user', content: 'I have Google Calendar connected. Build me a dashboard showing my events.' },
      { role: 'assistant', content: 'Great — I\'ll build you a calendar events dashboard. Since you already have Google Calendar connected, I can pull your events and write a React component. Let me set that up for you.' },
    ],
    input: 'Sounds good, go for it!',
    maxScore: 100,
    toolMocks: CANVAS_API_BIND_MOCKS,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Wrote a React component to src/',
        points: 20,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'fetched-real-data',
        description: 'Used Composio calendar tools to fetch real data',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS') || r.toolCalls.some(t => t.name.startsWith('GOOGLECALENDAR_')),
      },
      {
        id: 'code-has-event-data',
        description: 'React component includes calendar event data (standup, review)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('standup') || code.includes('review') || code.includes('meeting') || code.includes('event'))
        },
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'response-confirms-dashboard',
        description: 'Response mentions the dashboard or component with calendar events',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('dashboard') || text.includes('component') || text.includes('built')) &&
                 (text.includes('calendar') || text.includes('event') || text.includes('meeting'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Agent used fabricated sample data instead of fetching from Google Calendar',
    ],
  },

  // =========================================================================
  // Case 4: Full lifecycle — search → install → use → write React component
  // Level 5 | Multi-turn: discover GitHub, install, fetch, build component.
  // =========================================================================
  {
    id: 'tool-full-lifecycle',
    name: 'Tool System: Full lifecycle — discover, install, use, build component',
    category: 'tool-system',
    level: 5,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      { role: 'user', content: 'I want an issue tracker dashboard that pulls live data from my GitHub.' },
      { role: 'assistant', content: 'I can build that for you! I\'ll connect to your GitHub, pull your open issues, and create a React dashboard component. Which repository should I check?' },
      { role: 'user', content: 'Just use my default repos. Show the latest data in a table.' },
    ],
    input: 'Go ahead and build it!',
    maxScore: 100,
    toolMocks: TOOL_LIFECYCLE_FULL_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-github',
        description: 'Used tool_search to find GitHub integration',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_search'),
      },
      {
        id: 'installed-github',
        description: 'Used tool_install to connect GitHub',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install'),
      },
      {
        id: 'install-managed-style',
        description: 'tool_install used managed-style (no command/args) for Composio',
        points: 10,
        phase: 'execution',
        validate: (r) => installCalledWithoutCommand(r),
      },
      {
        id: 'fetched-issues',
        description: 'Called GitHub list issues tool directly',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'wrote-code-file',
        description: 'Wrote a React component to src/',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'code-has-issue-data',
        description: 'Component includes GitHub issue data (auth bypass, dark mode, etc.)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('auth') || code.includes('dark mode') || code.includes('memory leak') || code.includes('issue')
        },
      },
      {
        id: 'correct-lifecycle-order',
        description: 'Tools in correct order: search → install → fetch → write',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const searchIdx = r.toolCalls.findIndex(t => t.name === 'tool_search')
          const installIdx = r.toolCalls.findIndex(t => t.name === 'tool_install')
          const fetchIdx = r.toolCalls.findIndex(t => t.name === 'GITHUB_LIST_ISSUES')
          const writeIdx = r.toolCalls.findIndex(t => t.name === 'write_file')
          return searchIdx >= 0 && installIdx > searchIdx && fetchIdx > installIdx && writeIdx > fetchIdx
        },
      },
      {
        id: 'response-mentions-issues',
        description: 'Response mentions the GitHub issues',
        points: 5,
        phase: 'execution',
        validate: (r) => responseContains(r, 'issue') || responseContains(r, 'auth bypass') || responseContains(r, 'dark mode'),
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 5,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 25,
      },
    ],
    antiPatterns: [
      'Agent used placeholder data instead of fetching from GitHub',
    ],
  },

  // =========================================================================
  // Case 5: Managed tool install uses name-only (no command/args)
  // Level 2 | Verifies agent correctly differentiates managed vs catalog
  // =========================================================================
  {
    id: 'tool-managed-vs-catalog-install',
    name: 'Tool System: Managed install uses name-only, catalog uses command',
    category: 'tool-system',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'I need to be able to message my team on Slack and also scrape some websites.' },
    ],
    input: 'Can you set up both of those for me?',
    maxScore: 100,
    toolMocks: {
      tool_search: {
        type: 'pattern',
        description: 'Search for tools.',
        paramKeys: ['query', 'limit'],
        patterns: [
          {
            match: { query: 'slack' },
            response: {
              query: 'slack',
              results: [
                { name: 'Slack', qualifiedName: 'slack', description: 'Slack — managed OAuth integration.', source: 'managed', authType: 'oauth', composioToolkit: 'slack' },
              ],
              message: 'Found 1 tool(s).',
            },
          },
          {
            match: { query: 'browser' },
            response: {
              query: 'browser',
              results: [
                { name: 'Playwright Browser', qualifiedName: '@playwright/mcp@latest', description: 'Full browser automation.', source: 'catalog', installCommand: 'npx -y @playwright/mcp@latest', authType: 'none', icon: '🎭' },
              ],
              message: 'Found 1 tool(s).',
            },
          },
        ],
        default: { query: 'unknown', results: [], message: 'No tools found.' },
      },
      tool_install: {
        type: 'pattern',
        description: 'Install a tool.',
        paramKeys: ['name', 'command', 'args', 'env'],
        patterns: [
          {
            match: { name: 'slack' },
            response: { ok: true, server: 'composio', source: 'managed', toolCount: 2, connected: true, authStatus: 'active', tools: ['SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'SLACK_LIST_CHANNELS'], message: 'Connected Slack. Auth is active — connected and ready.' },
          },
          {
            match: { name: 'playwright' },
            response: { ok: true, server: 'playwright', source: 'catalog', toolCount: 6, tools: [{ name: 'mcp_playwright_browser_navigate', description: 'Navigate' }], message: 'Installed Playwright.' },
          },
        ],
        default: { error: 'Unknown tool' },
      },
    },
    validationCriteria: [
      {
        id: 'searched-both',
        description: 'Searched for both Slack and browser capabilities',
        points: 15,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return (json.includes('slack') || json.includes('messaging')) &&
                 (json.includes('browser') || json.includes('playwright') || json.includes('scraping') || json.includes('automat'))
        },
      },
      {
        id: 'installed-both',
        description: 'Called tool_install at least twice',
        points: 20,
        phase: 'intention',
        validate: (r) => r.toolCalls.filter(t => t.name === 'tool_install').length >= 2,
      },
      {
        id: 'slack-managed-style',
        description: 'Slack install used managed style (no command/args)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls
            .filter(t => t.name === 'tool_install')
            .some(t => {
              const input = t.input as Record<string, any>
              const name = (input.name || '').toLowerCase()
              return name.includes('slack') && !input.command && !input.args
            })
        },
      },
      {
        id: 'playwright-catalog-style',
        description: 'Playwright install used catalog style (with command or package)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls
            .filter(t => t.name === 'tool_install')
            .some(t => {
              const input = t.input as Record<string, any>
              const name = (input.name || '').toLowerCase()
              return name.includes('playwright') && (input.command || input.args || (input.name && input.name.includes('@')))
            })
        },
      },
      {
        id: 'response-confirms-both',
        description: 'Response confirms both tools are installed',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('slack') || text.includes('messaging')) &&
                 (text.includes('playwright') || text.includes('browser'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 10,
      },
    ],
    antiPatterns: [
      'Agent used command/args for a managed OAuth integration',
      'Agent used name-only install for a catalog MCP server',
    ],
  },

  // =========================================================================
  // Case 6: Composio install → fetch → React component
  // Level 3 | Agent installs managed integration, fetches data, writes component.
  // =========================================================================
  {
    id: 'tool-bind-at-install',
    name: 'Tool System: Install Composio integration and build component',
    category: 'tool-system',
    level: 3,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      { role: 'user', content: 'Show me my Google Calendar events on a dashboard.' },
      {
        role: 'assistant',
        content: 'I know how to connect Google Calendar. I\'ll install it and build a React dashboard with your events.',
      },
    ],
    input: 'Go ahead!',
    maxScore: 100,
    toolMocks: TOOL_BIND_AT_INSTALL_MOCKS,
    validationCriteria: [
      {
        id: 'installed-calendar',
        description: 'Used tool_install to connect Google Calendar',
        points: 25,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install'),
      },
      {
        id: 'wrote-code-file',
        description: 'Wrote a React component to src/',
        points: 20,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'fetched-events',
        description: 'Called a calendar tool to fetch events',
        points: 20,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t => t.name.startsWith('GOOGLECALENDAR_')),
      },
      {
        id: 'code-has-event-data',
        description: 'Component includes event data (standup, review, manager)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('standup') || code.includes('review') || code.includes('manager') || code.includes('event'))
        },
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 5,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Agent used fabricated sample data instead of fetching from Google Calendar',
    ],
  },
]
