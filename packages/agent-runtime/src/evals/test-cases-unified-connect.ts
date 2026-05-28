// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unified Connect / Search Integrations Eval Test Cases
 *
 * Pins the contract for the unified `search_integrations` / `connect` /
 * `disconnect` tool surface (see plan `unify-connect-disconnect-tools`).
 *
 * Each result of `connect` is tagged with a `source` field
 * (`'managed' | 'mcp' | 'skill'`) so downstream tools / UI can tell
 * which backend bound the new tools. These evals validate that:
 *
 *  1. `connect({ name: "gmail" })` (no source) routes to Composio and
 *     returns `source: 'managed'`.
 *  2. `connect({ name: "postgres" })` (no Composio match) falls through
 *     to MCP catalog and returns `source: 'mcp'`.
 *  3. `connect({ name: "myremote", url: "..." })` returns
 *     `source: 'mcp'` with `type: 'remote'`.
 *  4. `connect({ name: "gmail", source: "mcp" })` skips Composio and
 *     forces the MCP path.
 *  5. `search_integrations({ query: "google calendar" })` returns at
 *     least one result with `source: 'managed'`.
 */

import type { AgentEval } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  usedToolAnywhere,
  toolCallArgsContain,
  toolCallsJson,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Composio-first auto-routing: gmail resolves to a managed integration.
 */
const GMAIL_MANAGED_MOCKS: ToolMockMap = {
  search_integrations: {
    type: 'static',
    description: 'Search across managed OAuth integrations, skills, and MCP servers.',
    paramKeys: ['query', 'limit', 'source'],
    response: {
      query: 'gmail',
      results: [
        {
          name: 'Gmail',
          id: 'gmail',
          description: 'Gmail — managed OAuth integration. Send, read, search emails.',
          installCommand: 'connect({ name: "gmail" })',
          source: 'managed',
        },
      ],
      message: 'Found 1 result(s): 1 managed OAuth integration(s) (no credentials needed). Use connect to add one.',
    },
  },
  connect: {
    type: 'static',
    description: 'Install (connect) an integration so its tools become available.',
    paramKeys: ['name', 'source', 'env', 'url', 'headers'],
    response: {
      ok: true,
      source: 'managed',
      server: 'composio',
      integration: 'gmail',
      toolCount: 3,
      tools: ['GMAIL_SEND_EMAIL', 'GMAIL_LIST_MESSAGES', 'GMAIL_GET_MESSAGE'],
      authStatus: 'active',
      message: 'Installed "Gmail" with 3 tool(s). Auth is active. No manual credentials needed.',
    },
  },
}

/**
 * MCP fallback: postgres has no Composio match, so connect falls through
 * to the MCP catalog. Result must be tagged source=mcp.
 */
const POSTGRES_MCP_MOCKS: ToolMockMap = {
  search_integrations: {
    type: 'static',
    description: 'Search across managed OAuth integrations, skills, and MCP servers.',
    paramKeys: ['query', 'limit', 'source'],
    response: {
      query: 'postgres',
      results: [
        {
          name: 'PostgreSQL',
          id: 'postgres',
          description: 'Query PostgreSQL databases with read-only access.',
          installCommand: 'connect({ name: "postgres", source: "mcp" })',
          source: 'mcp',
        },
      ],
      message: 'Found 1 result(s): 1 MCP server(s). Use connect to add one.',
    },
  },
  connect: {
    type: 'static',
    description: 'Install (connect) an integration so its tools become available.',
    paramKeys: ['name', 'source', 'env', 'url', 'headers'],
    response: {
      ok: true,
      source: 'mcp',
      server: 'postgres',
      toolCount: 2,
      tools: [
        { name: 'mcp_postgres_query', description: 'Execute a read-only SQL query' },
        { name: 'mcp_postgres_list_tables', description: 'List tables in the database' },
      ],
      message: 'Installed MCP server "postgres" with 2 tool(s). They are now available for use.',
    },
  },
}

/**
 * Remote MCP: connect with a `url` arg connects to a remote MCP server.
 * Result is tagged `source: 'mcp'` with `type: 'remote'`.
 */
const REMOTE_MCP_MOCKS: ToolMockMap = {
  connect: {
    type: 'static',
    description: 'Install (connect) an integration so its tools become available.',
    paramKeys: ['name', 'source', 'env', 'url', 'headers'],
    response: {
      ok: true,
      source: 'mcp',
      type: 'remote',
      server: 'myremote',
      toolCount: 2,
      tools: [
        { name: 'mcp_myremote_ping', description: 'Health check' },
        { name: 'mcp_myremote_query', description: 'Run a query against the remote service' },
      ],
      message: 'Connected to remote MCP server "myremote" at https://my.example.com/mcp with 2 tool(s).',
    },
  },
}

/**
 * Forced MCP source: user explicitly asks to install gmail as an MCP
 * server (skipping Composio). The mock returns `source: 'mcp'` so the
 * eval validator can confirm the override path was taken.
 */
const GMAIL_FORCED_MCP_MOCKS: ToolMockMap = {
  connect: {
    type: 'static',
    description: 'Install (connect) an integration so its tools become available.',
    paramKeys: ['name', 'source', 'env', 'url', 'headers'],
    response: {
      ok: true,
      source: 'mcp',
      server: 'gmail',
      toolCount: 1,
      tools: [{ name: 'mcp_gmail_search', description: 'Custom MCP gmail server' }],
      message: 'Installed MCP server "gmail" with 1 tool(s).',
    },
  },
}

/**
 * Search-only fixture: validate that `search_integrations({ query: "google calendar" })`
 * returns at least one result tagged `source: 'managed'`.
 */
const GOOGLE_CALENDAR_SEARCH_MOCKS: ToolMockMap = {
  search_integrations: {
    type: 'static',
    description: 'Search across managed OAuth integrations, skills, and MCP servers.',
    paramKeys: ['query', 'limit', 'source'],
    response: {
      query: 'google calendar',
      results: [
        {
          name: 'Google Calendar',
          id: 'googlecalendar',
          description: 'Google Calendar — managed OAuth integration. Manage events, check availability.',
          installCommand: 'connect({ name: "googlecalendar" })',
          source: 'managed',
        },
      ],
      message: 'Found 1 result(s): 1 managed OAuth integration(s) (no credentials needed). Use connect to add one.',
    },
  },
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const UNIFIED_CONNECT_EVALS: AgentEval[] = [
  {
    id: 'unified-connect-managed-gmail',
    name: 'Unified connect: gmail routes to Composio (source=managed)',
    category: 'mcp-discovery',
    level: 2,
    input: 'Connect to my Gmail so you can read and send emails for me.',
    maxScore: 100,
    toolMocks: GMAIL_MANAGED_MOCKS,
    validationCriteria: [
      {
        id: 'called-connect',
        description: 'Called the unified `connect` tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'connect-with-gmail-name',
        description: 'connect args include name="gmail"',
        points: 25,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'connect', 'gmail'),
      },
      {
        id: 'no-explicit-source',
        description: 'Did NOT pass `source: "mcp"` (auto-routing should pick Composio first)',
        points: 25,
        phase: 'intention',
        validate: (r) => !toolCallArgsContain(r, 'connect', 'mcp'),
      },
      {
        id: 'response-or-result-mentions-managed',
        description: 'Mock response carries source=managed, model proceeds to use the bound tools',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallsJson(r).includes('source') && toolCallsJson(r).includes('managed'),
      },
    ],
    antiPatterns: ['Asks user for an OAuth token or API key', 'Tries to install a separate Gmail MCP server'],
  },

  {
    id: 'unified-connect-mcp-postgres',
    name: 'Unified connect: postgres falls through to MCP catalog (source=mcp)',
    category: 'mcp-discovery',
    level: 3,
    input: 'I want to query my PostgreSQL database. Set up the right tool for me.',
    maxScore: 100,
    toolMocks: POSTGRES_MCP_MOCKS,
    validationCriteria: [
      {
        id: 'called-connect',
        description: 'Called the unified `connect` tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'connect-with-postgres-name',
        description: 'connect args include name="postgres"',
        points: 25,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'connect', 'postgres'),
      },
      {
        id: 'result-tagged-mcp',
        description: 'Mock result carries source=mcp (auto-routed past Composio)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('source') && json.includes('mcp')
        },
      },
      {
        id: 'no-tool-install',
        description: 'Did NOT call legacy `tool_install` or `mcp_install`',
        points: 20,
        phase: 'intention',
        validate: (r) => !usedToolAnywhere(r, 'tool_install') && !usedToolAnywhere(r, 'mcp_install'),
      },
    ],
    antiPatterns: ['Calls legacy tool_install/mcp_install', 'Asks the user for the catalog list'],
  },

  {
    id: 'unified-connect-remote-url',
    name: 'Unified connect: remote MCP URL returns source=mcp, type=remote',
    category: 'mcp-discovery',
    level: 3,
    input: 'Connect to my custom MCP server at https://my.example.com/mcp — call it "myremote".',
    maxScore: 100,
    toolMocks: REMOTE_MCP_MOCKS,
    validationCriteria: [
      {
        id: 'called-connect',
        description: 'Called the unified `connect` tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'connect-passed-url',
        description: 'connect args include the remote URL',
        points: 35,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'connect', 'my.example.com'),
      },
      {
        id: 'connect-passed-name',
        description: 'connect args include name="myremote"',
        points: 20,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'connect', 'myremote'),
      },
      {
        id: 'no-tool-install',
        description: 'Did NOT call legacy `tool_install` or `mcp_install`',
        points: 15,
        phase: 'intention',
        validate: (r) => !usedToolAnywhere(r, 'tool_install') && !usedToolAnywhere(r, 'mcp_install'),
      },
    ],
    antiPatterns: ['Calls legacy mcp_install', 'Asks the user to wrap the URL in extra config'],
  },

  {
    id: 'unified-connect-source-override-mcp',
    name: 'Unified connect: explicit source="mcp" forces MCP path',
    category: 'mcp-discovery',
    level: 3,
    input:
      'I have a custom local MCP server I built that uses the name "gmail". Install it as an MCP server (not the managed Composio one).',
    maxScore: 100,
    toolMocks: GMAIL_FORCED_MCP_MOCKS,
    validationCriteria: [
      {
        id: 'called-connect',
        description: 'Called the unified `connect` tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'passed-source-mcp',
        description: 'connect args include source="mcp"',
        points: 40,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'connect', 'mcp'),
      },
      {
        id: 'connect-with-gmail-name',
        description: 'connect args include name="gmail"',
        points: 30,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'connect', 'gmail'),
      },
    ],
    antiPatterns: ['Calls connect without source: "mcp" (would auto-route to Composio)'],
  },

  {
    id: 'unified-search-integrations-managed',
    name: 'search_integrations returns source-tagged managed result for google calendar',
    category: 'mcp-discovery',
    level: 1,
    input: 'What integrations do you have for Google Calendar? Just show me, do not install anything yet.',
    maxScore: 100,
    toolMocks: GOOGLE_CALENDAR_SEARCH_MOCKS,
    validationCriteria: [
      {
        id: 'called-search',
        description: 'Called the unified `search_integrations` tool',
        points: 40,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'search-mentions-google-calendar',
        description: 'search query mentions google calendar',
        points: 25,
        phase: 'intention',
        validate: (r) => toolCallArgsContain(r, 'search_integrations', 'calendar'),
      },
      {
        id: 'result-tagged-managed',
        description: 'Mock returned source=managed in the result list',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('source') && json.includes('managed')
        },
      },
      {
        id: 'did-not-connect',
        description: 'Did NOT call connect (user said "do not install yet")',
        points: 10,
        phase: 'execution',
        validate: (r) => !usedToolAnywhere(r, 'connect'),
      },
    ],
    antiPatterns: ['Calls legacy tool_search or mcp_search', 'Installs anything despite the user asking just to see options'],
  },
]
