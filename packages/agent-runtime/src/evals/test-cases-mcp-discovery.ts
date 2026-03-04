/**
 * Tool Discovery Eval Test Cases
 *
 * Tests the agent's ability to discover, install, use, and manage tools
 * at runtime via the unified tool_search / tool_install interface.
 * Prompts simulate non-technical users who don't know about tools —
 * the agent must figure out that it needs new capabilities and go through
 * the search/install/use lifecycle autonomously.
 *
 * Multi-turn evals simulate the user answering natural follow-up questions
 * (e.g. "which repo?" → "acme-corp/backend").
 *
 * Two eval strategies based on mock system constraints:
 *
 * 1. Discovery-only evals (cases 5, 6): Post-install tools are NOT mocked,
 *    so the agent can't see them and is forced through the search → install
 *    flow. Validates that the agent recognizes it lacks a capability and
 *    proactively extends itself.
 *
 * 2. Usage evals (cases 7, 8): Post-install tools ARE mocked and visible.
 *    Multi-turn history handles the discovery phase. The final turn validates
 *    that the agent uses the installed tools effectively.
 */

import type { AgentEval } from './types'
import {
  MCP_LIST_INSTALLED_MOCKS,
  MCP_SEARCH_BASIC_MOCKS,
  MCP_INSTALL_AND_USE_MOCKS,
  MCP_UNINSTALL_MOCKS,
  MCP_SELF_EXTEND_FIGMA_MOCKS,
  MCP_SELF_EXTEND_DATABASE_MOCKS,
  MCP_MULTI_SERVER_MOCKS,
  MCP_DISCOVERY_PERSONALITY_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  usedToolInFinalTurn,
  toolCallCount,
  responseContains,
  toolCallsJson,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const MCP_DISCOVERY_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: What can you connect to?
  // Level 1 | User asks about capabilities → agent checks installed servers
  // =========================================================================
  {
    id: 'mcp-list-installed',
    name: 'Tool Discovery: User asks about extra capabilities',
    category: 'mcp-discovery',
    level: 1,
    input: 'What extra integrations or services do you have access to right now? I want to know what you can connect to beyond the basics.',
    maxScore: 100,
    toolMocks: MCP_LIST_INSTALLED_MOCKS,
    validationCriteria: [
      {
        id: 'used-list-installed',
        description: 'Used tool_search to check available servers',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'mentions-playwright',
        description: 'Response mentions the installed playwright/browser server',
        points: 30,
        phase: 'execution',
        validate: (r) => responseContains(r, 'playwright') || responseContains(r, 'browser'),
      },
      {
        id: 'mentions-capabilities',
        description: 'Response describes what the installed tools can do',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('navigate') || text.includes('screenshot') || text.includes('click') || text.includes('automat')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 5 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 5,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 2: Can you work with my database?
  // Level 2 | User asks about a capability → agent searches registry
  // Multi-turn: user says "just show me options"
  // =========================================================================
  {
    id: 'mcp-search-basic',
    name: 'Tool Discovery: User asks about database capability',
    category: 'mcp-discovery',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'Can you connect to my PostgreSQL database and run queries?' },
    ],
    input: 'Before you set anything up, just show me what options are available. I want to see what\'s out there first.',
    maxScore: 100,
    toolMocks: MCP_SEARCH_BASIC_MOCKS,
    validationCriteria: [
      {
        id: 'used-mcp-search',
        description: 'Used tool_search to find postgres servers',
        points: 35,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'search-mentions-postgres',
        description: 'Search query relates to postgres/database',
        points: 15,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('postgres') || json.includes('database') || json.includes('sql')
        },
      },
      {
        id: 'did-not-install',
        description: 'Did NOT install (user said just show options)',
        points: 20,
        phase: 'execution',
        validate: (r) => !usedToolInFinalTurn(r, 'tool_install'),
      },
      {
        id: 'response-lists-options',
        description: 'Response presents server options to the user',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'postgres'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 5 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 5,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 3: Set up file browsing and show me a directory
  // Level 3 | Single turn: search → install → use (all mocked)
  // =========================================================================
  {
    id: 'mcp-install-and-use',
    name: 'Tool Discovery: User wants to browse files',
    category: 'mcp-discovery',
    level: 3,
    input: 'I need to see what files are in /tmp on my server. Can you get yourself set up with a file browsing tool and then show me the directory listing?',
    maxScore: 100,
    toolMocks: MCP_INSTALL_AND_USE_MOCKS,
    validationCriteria: [
      {
        id: 'used-mcp-search',
        description: 'Used tool_search to find a filesystem server',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'used-mcp-install',
        description: 'Used tool_install to install the server',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'used-filesystem-tool',
        description: 'Used an MCP filesystem tool to list directory',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'mcp_filesystem_list_directory'),
      },
      {
        id: 'correct-sequence',
        description: 'Tools called in correct order: search → install → use',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const searchIdx = r.toolCalls.findIndex(t => t.name === 'tool_search')
          const installIdx = r.toolCalls.findIndex(t => t.name === 'tool_install')
          const useIdx = r.toolCalls.findIndex(t => t.name === 'mcp_filesystem_list_directory')
          return searchIdx >= 0 && installIdx > searchIdx && useIdx > installIdx
        },
      },
      {
        id: 'response-has-contents',
        description: 'Response mentions directory contents',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'report') || responseContains(r, 'data') || responseContains(r, 'csv'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 8,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 4: Stop using Slack
  // Level 2 | Multi-turn: user asks about integrations, then removes one
  // =========================================================================
  {
    id: 'mcp-uninstall',
    name: 'Tool Discovery: User asks to disconnect Slack',
    category: 'mcp-discovery',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'What integrations do I have set up right now?' },
      { role: 'assistant', content: 'You currently have **Slack** installed with 5 tools: SLACK_SEND_MESSAGE, SLACK_LIST_CHANNELS, SLACK_READ_MESSAGES, SLACK_SET_TOPIC, SLACK_LIST_USERS.' },
    ],
    input: 'OK, I don\'t use Slack anymore. Remove that one please.',
    maxScore: 100,
    toolMocks: MCP_UNINSTALL_MOCKS,
    validationCriteria: [
      {
        id: 'used-mcp-uninstall',
        description: 'Used tool_uninstall to remove the server',
        points: 50,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_uninstall'),
      },
      {
        id: 'uninstalled-slack',
        description: 'Uninstalled the slack server specifically',
        points: 25,
        phase: 'execution',
        validate: (r) => toolCallsJson(r).includes('slack'),
      },
      {
        id: 'response-confirms',
        description: 'Response confirms the removal',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('removed') || text.includes('uninstall') || text.includes('disconnect')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 5 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 5,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 5: I need to pull assets from Figma
  // Level 3 | Discovery-only: agent has no built-in Figma capability.
  //           Multi-turn: agent may ask for credentials, user provides them.
  // =========================================================================
  {
    id: 'mcp-self-extend-figma',
    name: 'Tool Discovery: User wants Figma access',
    category: 'mcp-discovery',
    level: 3,
    conversationHistory: [
      { role: 'user', content: 'I need to pull some design assets from our Figma project. Can you get set up to access Figma so you can look at our design files?' },
    ],
    input: 'My Figma access token is fgma_abc123_test. Go ahead and set it up!',
    maxScore: 100,
    toolMocks: MCP_SELF_EXTEND_FIGMA_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-capability',
        description: 'Used tool_search to find a Figma capability',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-mcp-server',
        description: 'Used tool_install to add the Figma capability',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'passed-token',
        description: 'Passed the Figma token during install',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('fgma_') || json.includes('figma') || json.includes('token')
        },
      },
      {
        id: 'response-reports-install',
        description: 'Response tells user about the installed Figma capability',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('install') || text.includes('set up') || text.includes('figma') || text.includes('design') || text.includes('ready')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 8,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 6: I need to check my database
  // Level 3 | Discovery-only: no postgres tools mocked. Agent must install
  //           DB access with the connection string. Multi-turn: the history
  //           turn may trigger tool_search, so the final turn validates
  //           install + config passing, not necessarily a fresh search.
  // =========================================================================
  {
    id: 'mcp-self-extend-database',
    name: 'Tool Discovery: User wants to connect to their database',
    category: 'mcp-discovery',
    level: 3,
    conversationHistory: [
      { role: 'user', content: 'I need to check something in my Postgres database. Can you help me with that?' },
    ],
    input: 'Sure, the connection string is postgres://admin:secret@localhost:5432/myapp. Go ahead and get that set up.',
    maxScore: 100,
    toolMocks: MCP_SELF_EXTEND_DATABASE_MOCKS,
    validationCriteria: [
      {
        id: 'used-discovery-or-install',
        description: 'Used tool_search or tool_install (discovery flow)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search') || usedTool(r, 'tool_install'),
      },
      {
        id: 'installed-mcp-server',
        description: 'Used tool_install to add the postgres server',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'passed-connection-config',
        description: 'Passed connection string or config during install',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('postgres://') || json.includes('5432') || json.includes('myapp') || json.includes('connection')
        },
      },
      {
        id: 'response-reports-setup',
        description: 'Response tells user about the installed database connection',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('install') || text.includes('set up') || text.includes('postgres') || text.includes('database') || text.includes('connect')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 8,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 7: Check our PRs and tell the team on Slack
  // Level 5 | Multi-turn usage eval: history handles discovery, final turn
  //           validates that agent uses GitHub + Slack tools effectively.
  // =========================================================================
  {
    id: 'mcp-multi-server-orchestration',
    name: 'Tool Discovery: GitHub PR review + Slack notification',
    category: 'mcp-discovery',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'I want you to check our GitHub repo for any urgent pull requests that need attention, and then post a summary to our Slack so the team knows.' },
      { role: 'assistant', content: 'I can help with that! I\'ll need to set up GitHub and Slack integrations first. Which repository should I check, and which Slack channel should I post to?' },
      { role: 'user', content: 'The repo is acme-corp/backend. Post to #engineering.' },
    ],
    input: 'Go ahead!',
    maxScore: 100,
    toolMocks: MCP_MULTI_SERVER_MOCKS,
    validationCriteria: [
      {
        id: 'used-github-tool',
        description: 'Used a GitHub tool to fetch PRs',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'mcp_github_list_pull_requests'),
      },
      {
        id: 'used-slack-tool',
        description: 'Used a Slack tool to send a message',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'mcp_slack_send_message'),
      },
      {
        id: 'slack-mentions-pr',
        description: 'Slack message references the PRs or urgent items',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const slackCall = r.toolCalls.find(t => t.name === 'mcp_slack_send_message')
          if (!slackCall) return false
          const json = JSON.stringify(slackCall.input).toLowerCase()
          return json.includes('auth') || json.includes('pr') || json.includes('pull') || json.includes('#42') || json.includes('fix') || json.includes('critical') || json.includes('urgent')
        },
      },
      {
        id: 'correct-sequence',
        description: 'Fetched PRs before sending Slack message',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const ghIdx = r.toolCalls.findIndex(t => t.name === 'mcp_github_list_pull_requests')
          const slackIdx = r.toolCalls.findIndex(t => t.name === 'mcp_slack_send_message')
          return ghIdx >= 0 && slackIdx > ghIdx
        },
      },
      {
        id: 'response-summarizes',
        description: 'Response summarizes what was done',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('slack') || text.includes('sent') || text.includes('posted')) &&
                 (text.includes('pr') || text.includes('pull'))
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
    antiPatterns: ['No tool calls at all'],
  },

  // =========================================================================
  // Case 8: Become my project management assistant
  // Level 4 | Multi-turn usage eval: history handles discovery, final turn
  //           validates the agent uses Linear tools + saves to memory.
  // =========================================================================
  {
    id: 'mcp-discovery-to-personality',
    name: 'Tool Discovery: Become a project management assistant',
    category: 'mcp-discovery',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I want you to become my project management assistant. We use Linear for tracking issues and sprints.' },
      { role: 'assistant', content: 'I\'d love to help with project management! Let me search for a Linear integration so I can access your issues and projects directly.' },
    ],
    input: 'Great, pull my current issues to make sure it\'s all working, and then save a note to yourself reminding you that you\'re now my project management assistant so you don\'t forget next time.',
    maxScore: 100,
    toolMocks: MCP_DISCOVERY_PERSONALITY_MOCKS,
    validationCriteria: [
      {
        id: 'used-linear-tool',
        description: 'Used a Linear tool to pull issues',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'mcp_linear_list_issues'),
      },
      {
        id: 'wrote-memory',
        description: 'Used memory_write to record the new role',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'memory-mentions-role',
        description: 'Memory entry references Linear or project management',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const memCall = r.toolCalls.find(t => t.name === 'memory_write')
          if (!memCall) return false
          const json = JSON.stringify(memCall.input).toLowerCase()
          return json.includes('linear') || json.includes('project management') || json.includes('project manager')
        },
      },
      {
        id: 'response-shows-issues',
        description: 'Response mentions the Linear issues',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          return responseContains(r, 'sso') || responseContains(r, 'dashboard') || responseContains(r, 'csv') || responseContains(r, 'LIN-')
        },
      },
      {
        id: 'response-confirms-setup',
        description: 'Response confirms the role and setup',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('project management') || text.includes('assistant') || text.includes('remember') || text.includes('noted') || text.includes('saved')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 12,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },
]
