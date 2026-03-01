/**
 * Unified Tool System Eval Test Cases
 *
 * Tests the unified tool_search / tool_install / tool_uninstall / tool_list
 * interface that abstracts Composio (managed OAuth) and catalog (local MCP)
 * sources behind a single agent-facing API.
 *
 * Also tests:
 * - canvas_api_bind: binding installed tool CRUD to the canvas
 * - Mixed search results spanning managed + catalog sources
 * - Catalog-only install-and-use flow (no auth needed)
 * - Full lifecycle: search → install → use → bind → canvas
 */

import type { AgentEval } from './types'
import {
  UNIFIED_SEARCH_MIXED_MOCKS,
  JIRA_SLACK_INSTALL_USE_MOCKS,
  CANVAS_API_BIND_MOCKS,
  TOOL_LIFECYCLE_FULL_MOCKS,
  TOOL_BIND_AT_INSTALL_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  usedToolInFinalTurn,
  neverUsedTool,
  responseContains,
  toolCallsJson,
  toolCallArgsContain,
  installCalledWithoutCommand,
} from './eval-helpers'

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
        validate: (r) => neverUsedTool(r, 'tool_install'),
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
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-integrations',
        description: 'Used tool_install to connect at least one integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
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
  // Case 3: Composio auto-bind — install managed integration, create canvas
  // Level 4 | Pre-installed Composio → agent fetches data + builds canvas
  // Auto-bind handles CRUD binding automatically for managed integrations.
  // =========================================================================
  {
    id: 'tool-canvas-api-bind',
    name: 'Tool System: Auto-bind Composio integration to canvas',
    category: 'tool-system',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I have Google Calendar connected. Build me a dashboard showing my events.' },
      { role: 'assistant', content: 'Great — I\'ll build you a calendar events dashboard. Since you already have Google Calendar connected, I can pull your events in real-time. Let me set that up for you.' },
    ],
    input: 'Sounds good, go for it!',
    maxScore: 100,
    toolMocks: CANVAS_API_BIND_MOCKS,
    validationCriteria: [
      {
        id: 'created-canvas',
        description: 'Created a canvas surface',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'fetched-real-data',
        description: 'Used Composio calendar tools to fetch real data',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS') || r.toolCalls.some(t => t.name.startsWith('GOOGLECALENDAR_')),
      },
      {
        id: 'populated-canvas-data',
        description: 'Pushed fetched data to canvas via canvas_data',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_data'),
      },
      {
        id: 'built-ui',
        description: 'Built canvas UI with canvas_update',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'response-confirms-dashboard',
        description: 'Response mentions the dashboard or canvas with calendar events',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('dashboard') || text.includes('canvas') || text.includes('built')) &&
                 (text.includes('calendar') || text.includes('event') || text.includes('meeting'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Agent used fabricated sample data instead of fetching from Google Calendar',
    ],
  },

  // =========================================================================
  // Case 4: Full lifecycle — search → install → use → bind → canvas
  // Level 5 | Multi-turn: agent already knows about canvas_api_bind.
  //           Complete end-to-end: discover GitHub, install, fetch, build canvas,
  //           and bind live data with canvas_api_bind.
  // =========================================================================
  {
    id: 'tool-full-lifecycle',
    name: 'Tool System: Full lifecycle — discover, install, use, bind to canvas',
    category: 'tool-system',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'I want an issue tracker dashboard that pulls live data from my GitHub.' },
      { role: 'assistant', content: 'I can build that for you! I\'ll connect to your GitHub, pull your open issues, and create a live dashboard that stays up to date with your repos. Which repository should I check?' },
      { role: 'user', content: 'Just use my default repos. I want it to always show the latest data, not a stale snapshot.' },
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
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-github',
        description: 'Used tool_install to connect GitHub',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
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
        id: 'created-canvas',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'bound-api',
        description: 'Used canvas_api_bind to wire GitHub data to canvas',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_bind'),
      },
      {
        id: 'bind-has-datapath',
        description: 'canvas_api_bind includes dataPath for auto-query',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const bindCall = r.toolCalls.find(t => t.name === 'canvas_api_bind')
          if (!bindCall) return false
          const input = bindCall.input as Record<string, any>
          return typeof input.dataPath === 'string' && input.dataPath.startsWith('/')
        },
      },
      {
        id: 'correct-lifecycle-order',
        description: 'Tools in correct order: search → install → fetch, then create and bind both after fetch',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const searchIdx = r.toolCalls.findIndex(t => t.name === 'tool_search')
          const installIdx = r.toolCalls.findIndex(t => t.name === 'tool_install')
          const fetchIdx = r.toolCalls.findIndex(t => t.name === 'GITHUB_LIST_ISSUES')
          const createIdx = r.toolCalls.findIndex(t => t.name === 'canvas_create' || t.name === 'canvas_delegate')
          const bindIdx = r.toolCalls.findIndex(t => t.name === 'canvas_api_bind')
          return searchIdx >= 0 && installIdx > searchIdx && fetchIdx > installIdx &&
                 createIdx > fetchIdx && bindIdx > fetchIdx
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
        id: 'response-mentions-live',
        description: 'Response mentions live data or real-time updates',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('live') || text.includes('real-time') || text.includes('realtime') || text.includes('update')
        },
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
      'Agent skipped canvas_api_bind and only used canvas_api_schema',
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
      tool_list: {
        type: 'static',
        description: 'List installed tools.',
        paramKeys: [],
        response: { servers: [], totalServers: 0, totalTools: 0 },
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
  // Case 6: Composio auto-bind — install with auto-bind deferred, create canvas
  // Level 3 | Agent installs managed integration, auto-bind handles CRUD.
  //           Agent should trust the auto-bind and create canvas efficiently.
  // =========================================================================
  {
    id: 'tool-bind-at-install',
    name: 'Tool System: Composio auto-bind install flow',
    category: 'tool-system',
    level: 3,
    conversationHistory: [
      { role: 'user', content: 'Show me my Google Calendar events on a dashboard.' },
      {
        role: 'assistant',
        content: 'I know how to connect Google Calendar. I\'ll install it and set up a live dashboard with your events.',
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
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'created-canvas',
        description: 'Created a canvas surface',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'fetched-events',
        description: 'Called a calendar tool to fetch events',
        points: 20,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t => t.name.startsWith('GOOGLECALENDAR_')),
      },
      {
        id: 'built-ui',
        description: 'Built canvas UI with canvas_update',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 12,
      },
    ],
    antiPatterns: [
      'Agent used fabricated sample data instead of fetching from Google Calendar',
    ],
  },
]
