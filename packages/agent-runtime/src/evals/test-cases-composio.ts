// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Composio Integration Eval Test Cases
 *
 * Tests the agent's ability to discover, install, and use Composio-backed
 * integrations (Google Calendar, Gmail, GitHub, etc.) via the search_integrations →
 * connect → direct toolkit tool calls flow.
 *
 * connect now registers individual proxy tools (e.g. GOOGLECALENDAR_LIST_EVENTS)
 * and handles auth automatically. The agent calls tools directly, not via meta-tools.
 *
 * Also tests:
 * - Composio preference over local/npm MCP servers
 * - Skill-based shortcutting (skip discovery when skill exists)
 * - Auth flow handling (connect returns authUrl)
 * - Write operations (sending emails)
 */

import type { AgentEval } from './types'
import {
  COMPOSIO_GOOGLE_CALENDAR_MOCKS,
  COMPOSIO_PREFERENCE_MOCKS,
  COMPOSIO_AUTH_REQUIRED_MOCKS,
  COMPOSIO_GMAIL_SEND_MOCKS,
  COMPOSIO_GITHUB_PR_SKILL_SAVE_MOCKS,
  COMPOSIO_AUTH_ERROR_MOCKS,
  COMPOSIO_NOTFOUND_ERROR_MOCKS,
  AIRBNB_SKILL_SAVE_MOCKS,
  COMPOSIO_CALENDAR_FOLLOWUP_MOCKS,
  COMPOSIO_GMAIL_CALENDAR_MULTI_MOCKS,
  withHiddenNativeTools,
} from './tool-mocks'

// Native built-in tools the model can use to bypass the integration flow these
// evals are trying to measure. We hide them per-eval so the model has to go
// through `search_integrations` → `connect` → toolkit tool, instead of:
//   - `send_message` to "email" someone (it advertises email/slack/discord)
//   - `edit_file`/`exec`/`agent_spawn`/`browser`/`web` to spiral into a
//     canvas-building or research detour instead of just calling the tool.
//
// `read_file`/`write_file` stay visible for the skill-save evals (which
// require write_file to persist the skill) and are hidden for the pure
// tool-call evals where neither is needed.
const INTEGRATION_BYPASS_TOOLS = [
  'send_message',
  'edit_file',
  'exec',
  'agent_spawn',
  'browser',
  'web',
]
const PURE_TOOL_CALL_HIDES = [
  ...INTEGRATION_BYPASS_TOOLS,
  'read_file',
  'write_file',
]
const SKILL_SAVE_HIDES = [
  ...INTEGRATION_BYPASS_TOOLS,
  'read_file',
]
import {
  usedTool,
  usedToolAnywhere,
  usedToolInFinalTurn,
  neverUsedTool,
  delegatedTo,
  toolCallCount,
  responseContains,
  toolCallArgsContain,
  installCalledWithoutCommand,
} from './eval-helpers'

// True if the response surfaces *actionable* reconnect / re-authorize guidance
// to the user (rather than swallowing the error or asserting fake success).
const surfacesReconnectGuidance = (r: any): boolean =>
  responseContains(r, 'reconnect') ||
  responseContains(r, 're-connect') ||
  responseContains(r, 'reconnnect') ||
  responseContains(r, 'reauthorize') ||
  responseContains(r, 're-authorize') ||
  responseContains(r, 'authorize again') ||
  responseContains(r, 'expired') ||
  (responseContains(r, 'connect') && responseContains(r, 'again')) ||
  (responseContains(r, 'authoriz') && responseContains(r, 'gmail'))

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const COMPOSIO_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Google Calendar via Composio
  // Level 2 | Full discovery flow: search → install → call tool directly
  // =========================================================================
  {
    id: 'composio-google-calendar',
    name: 'Composio: Google Calendar event listing',
    category: 'mcp-discovery',
    level: 2,
    input: 'Show me my calendar meetings for this week',
    maxScore: 100,
    toolMocks: COMPOSIO_GOOGLE_CALENDAR_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-calendar',
        description: 'Used search_integrations to find Google Calendar',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'installed-composio',
        description: 'Used connect to connect Composio integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'install-no-command',
        description: 'connect called without command/args (Composio needs only name)',
        points: 10,
        phase: 'execution',
        validate: (r) => installCalledWithoutCommand(r),
      },
      {
        id: 'used-calendar-tool',
        description: 'Called a Google Calendar tool directly to fetch events',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS') || usedTool(r, 'GOOGLECALENDAR_EVENTS_LIST'),
      },
      {
        id: 'response-has-events',
        description: 'Response mentions calendar events/meetings',
        points: 25,
        phase: 'execution',
        validate: (r) => responseContains(r, 'standup') || responseContains(r, 'meeting') || responseContains(r, 'product review'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 6 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 6,
      },
    ],
    antiPatterns: [
      'Agent tried to install a local/npm Google Calendar MCP instead of using Composio',
      'Agent used placeholder/sample data instead of tool results',
    ],
  },

  // =========================================================================
  // Case 2: Composio preferred over local MCP
  // Level 2 | Search returns both Composio and npm results → agent picks Composio
  // =========================================================================
  {
    id: 'composio-preference',
    name: 'Composio: Prefers Composio over npm MCP',
    category: 'mcp-discovery',
    level: 2,
    input: 'Check my GitHub issues and show me the open bugs',
    maxScore: 100,
    toolMocks: COMPOSIO_PREFERENCE_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-github',
        description: 'Used search_integrations to find GitHub',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'installed-composio',
        description: 'Used connect (for Composio, not npm)',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'install-composio-name',
        description: 'connect used Composio toolkit name (no command/args)',
        points: 15,
        phase: 'execution',
        validate: (r) => installCalledWithoutCommand(r),
      },
      {
        id: 'used-composio-tools',
        description: 'Used Composio proxy tools (not local MCP tools)',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => t.name.startsWith('GITHUB_')),
      },
      {
        id: 'executed-github-query',
        description: 'Called GitHub list issues tool directly',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_REPOSITORY_ISSUES'),
      },
      {
        id: 'response-has-issues',
        description: 'Response mentions the mock issues',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'login') || responseContains(r, 'memory leak') || responseContains(r, 'dark mode'),
      },
    ],
    antiPatterns: [
      'Agent installed the npm @modelcontextprotocol/server-github instead of using Composio',
      'Agent passed command or args to connect for a Composio integration',
    ],
  },

  // =========================================================================
  // Case 3: Skill-based shortcutting
  // Level 3 | Pre-loaded skill → agent skips discovery, goes straight to execute
  // =========================================================================
  {
    id: 'composio-skill-shortcut',
    name: 'Composio: Skill-based discovery skip',
    category: 'mcp-discovery',
    level: 3,
    input: 'What meetings do I have tomorrow?',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(
      { ...COMPOSIO_GOOGLE_CALENDAR_MOCKS },
      PURE_TOOL_CALL_HIDES,
    ),
    workspaceFiles: {
      'skills/google-calendar.md': `---
name: google-calendar
version: 1.0.0
description: List Google Calendar events for a specified time range.
trigger: "google calendar|calendar events|my meetings|my schedule|upcoming events|weekly calendar|show my calendar|list meetings|meetings|calendar"
tools: [GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS, GOOGLECALENDAR_CREATE_EVENT, connect]
---
# Google Calendar

This skill provides everything needed — do NOT call search_integrations.

## Setup
1. Ensure Composio is connected: connect({ name: "googlecalendar" })
   (Auth is checked automatically by connect)

## Available Tools
- GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS — List events across all calendars
- GOOGLECALENDAR_LIST_CALENDARS — List all calendars
- GOOGLECALENDAR_CREATE_EVENT — Create a new event

## Execution
Call the tools directly. Example:
GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS({ time_min: "...", time_max: "..." })
`,
    },
    validationCriteria: [
      {
        id: 'used-calendar-tool',
        description: 'Called Google Calendar tool directly to fetch events',
        points: 30,
        phase: 'execution',
        validate: (r) => usedToolInFinalTurn(r, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'),
      },
      {
        id: 'skipped-search',
        description: 'Did NOT use search_integrations at all (skill provides the info)',
        points: 25,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'search_integrations') && !delegatedTo(r, 'integration'),
      },
      {
        id: 'fewer-tool-calls',
        description: 'Completed in <= 4 tool calls (faster than full discovery)',
        points: 20,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 4,
      },
      {
        id: 'response-has-events',
        description: 'Response mentions calendar events',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'standup') || responseContains(r, 'meeting') || responseContains(r, 'event'),
      },
      {
        id: 'used-install',
        description: 'Still called connect to ensure Composio is connected',
        points: 10,
        phase: 'execution',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
    ],
    antiPatterns: [
      'Agent searched for Google Calendar despite having a loaded skill',
    ],
  },

  // =========================================================================
  // Case 4: Auth flow — not yet connected
  // Level 2 | connect returns authStatus: 'needs_auth' + authUrl → agent shows URL
  // =========================================================================
  {
    id: 'composio-auth-flow',
    name: 'Composio: Auth URL presentation when not connected',
    category: 'mcp-discovery',
    level: 2,
    input: 'Show me my recent emails',
    maxScore: 100,
    toolMocks: COMPOSIO_AUTH_REQUIRED_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-gmail',
        description: 'Used search_integrations to find Gmail',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'installed-composio',
        description: 'Used connect for Gmail (returns authUrl)',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'showed-auth-url',
        description: 'Response includes the auth/connect URL from connect',
        points: 35,
        phase: 'execution',
        validate: (r) => responseContains(r, 'connect.composio.dev') || responseContains(r, 'authenticate') || responseContains(r, 'authorize') || responseContains(r, 'connect'),
      },
      {
        id: 'did-not-execute-without-auth',
        description: 'Did NOT call Gmail tools (user needs to auth first)',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'GMAIL_FETCH_EMAILS') && neverUsedTool(r, 'GMAIL_SEND_EMAIL'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 6 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 6,
      },
    ],
    antiPatterns: [
      'Agent executed tools without user authentication',
      'Agent did not present the auth URL to the user',
    ],
  },

  // =========================================================================
  // Case 5: Gmail send email via Composio
  // Level 3 | Discovery + write operation
  // =========================================================================
  {
    id: 'composio-gmail-send',
    name: 'Composio: Send email via Gmail',
    category: 'mcp-discovery',
    level: 3,
    input: 'Send an email to john@example.com about the meeting tomorrow at 2pm. Subject: "Meeting Tomorrow" and let him know we will discuss the Q1 roadmap.',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(COMPOSIO_GMAIL_SEND_MOCKS, PURE_TOOL_CALL_HIDES),
    validationCriteria: [
      {
        id: 'searched-for-gmail',
        description: 'Used search_integrations to find Gmail',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'installed-composio',
        description: 'Used connect for Gmail via Composio',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'used-gmail-send',
        description: 'Called GMAIL_SEND_EMAIL directly to send the email',
        points: 30,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GMAIL_SEND_EMAIL'),
      },
      {
        id: 'send-has-recipient',
        description: 'GMAIL_SEND_EMAIL call includes the recipient',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'GMAIL_SEND_EMAIL', 'john@example.com') || toolCallArgsContain(r, 'GMAIL_SEND_EMAIL', 'john'),
      },
      {
        id: 'response-confirms-sent',
        description: 'Response confirms the email was sent',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'sent') || responseContains(r, 'delivered') || responseContains(r, 'email'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
    antiPatterns: [
      'Agent installed npm Gmail MCP instead of Composio',
      'Agent used placeholder/mock data instead of actually executing the send',
    ],
  },

  // =========================================================================
  // Case 6: Skill auto-save after Composio flow
  // Level 3 | Full discovery + verify skill saved with natural naming
  // =========================================================================
  {
    id: 'composio-skill-save',
    name: 'Composio: Auto-save skill after successful flow',
    category: 'mcp-discovery',
    level: 3,
    // Fix D: explicit ask to save a skill. The prior prompt only asked
    // for PRs and relied on the agent's discretion to auto-save, which
    // never fired under the haiku model — the eval is testing the save
    // step itself, so we make the requirement obvious.
    input: 'Show me my open pull requests on GitHub. After you do, save a reusable skill at skills/<short-name>.md (with a YAML frontmatter trigger line and the GitHub tool names you used) so I can repeat this faster next time.',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(COMPOSIO_GITHUB_PR_SKILL_SAVE_MOCKS, SKILL_SAVE_HIDES),
    validationCriteria: [
      {
        id: 'completed-discovery',
        description: 'Completed the full Composio discovery flow',
        points: 15,
        phase: 'execution',
        validate: (r) => usedToolAnywhere(r, 'search_integrations') && usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'fetched-prs',
        description: 'Called GitHub list pull requests tool directly',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_PULL_REQUESTS'),
      },
      {
        id: 'response-mentions-prs',
        description: 'Response mentions the mock pull requests',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth') || responseContains(r, 'logging') || responseContains(r, 'pull request'),
      },
      {
        id: 'saved-skill-file',
        description: 'Called write_file to save a skill',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls
            .filter(t => t.name === 'write_file')
            .some(t => {
              const path = ((t.input as Record<string, any>).path || '') as string
              return path.startsWith('skills/') && path.endsWith('.md')
            })
        },
      },
      {
        id: 'natural-naming',
        description: 'Skill filename does NOT use composio- or mcp- prefix',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const writeCall = r.toolCalls.find(t => {
            if (t.name !== 'write_file') return false
            const path = ((t.input as Record<string, any>).path || '') as string
            return path.startsWith('skills/') && path.endsWith('.md')
          })
          if (!writeCall) return false
          const path = ((writeCall.input as Record<string, any>).path || '') as string
          const filename = path.replace('skills/', '')
          return !filename.startsWith('composio-') && !filename.startsWith('mcp-')
        },
      },
      {
        id: 'skill-has-trigger',
        description: 'Saved skill content includes a trigger field',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writeCall = r.toolCalls.find(t => {
            if (t.name !== 'write_file') return false
            const path = ((t.input as Record<string, any>).path || '') as string
            return path.startsWith('skills/') && path.endsWith('.md')
          })
          if (!writeCall) return false
          const content = ((writeCall.input as Record<string, any>).content || '') as string
          return content.includes('trigger:')
        },
      },
      {
        id: 'skill-has-tools',
        description: 'Saved skill content includes tool slugs from discovery',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writeCall = r.toolCalls.find(t => {
            if (t.name !== 'write_file') return false
            const path = ((t.input as Record<string, any>).path || '') as string
            return path.startsWith('skills/') && path.endsWith('.md')
          })
          if (!writeCall) return false
          const content = ((writeCall.input as Record<string, any>).content || '') as string
          return content.includes('GITHUB_LIST_PULL_REQUESTS') || content.includes('PULL_REQUEST')
        },
      },
    ],
    antiPatterns: [
      'Agent used composio- prefix in skill filename',
      'Agent skipped saving a skill after successful integration',
    ],
  },

  // =========================================================================
  // Case 7: Skill auto-save after local MCP flow
  // Level 3 | search → install local → use → save skill with natural naming
  // =========================================================================
  {
    id: 'mcp-skill-save',
    name: 'Local MCP: Auto-save skill after successful flow',
    category: 'mcp-discovery',
    level: 3,
    // Fix D: explicit save-skill ask; same rationale as composio-skill-save.
    input: 'Search for Airbnb listings in Bali for 2 adults, March 15-22. After the search, save a reusable skill at skills/<short-name>.md (with a YAML frontmatter trigger line and the airbnb tool + connect setup) so I can repeat this faster next time.',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(AIRBNB_SKILL_SAVE_MOCKS, SKILL_SAVE_HIDES),
    validationCriteria: [
      {
        id: 'completed-discovery',
        description: 'Searched and installed the Airbnb MCP server',
        points: 15,
        phase: 'execution',
        validate: (r) => usedToolAnywhere(r, 'search_integrations') && usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'used-airbnb-search',
        description: 'Used the airbnb_search tool to find listings',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'mcp_airbnb_airbnb_search'),
      },
      {
        id: 'response-has-listings',
        description: 'Response mentions the mock Bali listings',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'ubud') || responseContains(r, 'bali') || responseContains(r, 'villa'),
      },
      {
        id: 'saved-skill-file',
        description: 'Called write_file to save a skill',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls
            .filter(t => t.name === 'write_file')
            .some(t => {
              const path = ((t.input as Record<string, any>).path || '') as string
              return path.startsWith('skills/') && path.endsWith('.md')
            })
        },
      },
      {
        id: 'natural-naming',
        description: 'Skill filename does NOT use composio- or mcp- prefix',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const writeCall = r.toolCalls.find(t => {
            if (t.name !== 'write_file') return false
            const path = ((t.input as Record<string, any>).path || '') as string
            return path.startsWith('skills/') && path.endsWith('.md')
          })
          if (!writeCall) return false
          const path = ((writeCall.input as Record<string, any>).path || '') as string
          const filename = path.replace('skills/', '')
          return !filename.startsWith('composio-') && !filename.startsWith('mcp-')
        },
      },
      {
        id: 'skill-has-install-command',
        description: 'Saved skill includes the install command for the MCP server',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writeCall = r.toolCalls.find(t => {
            if (t.name !== 'write_file') return false
            const path = ((t.input as Record<string, any>).path || '') as string
            return path.startsWith('skills/') && path.endsWith('.md')
          })
          if (!writeCall) return false
          const content = ((writeCall.input as Record<string, any>).content || '') as string
          return content.includes('airbnb') && content.includes('connect')
        },
      },
      {
        id: 'skill-has-trigger',
        description: 'Saved skill content includes a trigger field',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writeCall = r.toolCalls.find(t => {
            if (t.name !== 'write_file') return false
            const path = ((t.input as Record<string, any>).path || '') as string
            return path.startsWith('skills/') && path.endsWith('.md')
          })
          if (!writeCall) return false
          const content = ((writeCall.input as Record<string, any>).content || '') as string
          return content.includes('trigger:')
        },
      },
    ],
    antiPatterns: [
      'Agent used mcp- prefix in skill filename',
      'Agent skipped saving a skill after successful integration',
    ],
  },

  // =========================================================================
  // Case 8: Multi-turn follow-up after integration use
  // Level 3 | Turn 1 listed calendar events, turn 2 creates a new event
  // =========================================================================
  {
    id: 'composio-multiturn-followup',
    name: 'Composio: Multi-turn follow-up (create event after listing)',
    category: 'mcp-discovery',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Show me my calendar events for today',
      },
      {
        role: 'assistant',
        content: 'Here are your calendar events for today:\n\n1. **Team Standup** — 9:00 AM - 9:15 AM\n2. **Product Review** — 11:00 AM - 12:00 PM\n3. **Lunch with Sarah** — 12:30 PM - 1:30 PM\n\nYou have 3 events scheduled. Would you like me to do anything else with your calendar?',
      },
    ],
    input: 'Create a new event for tomorrow at 2pm called "Team Sync" for one hour',
    maxScore: 100,
    toolMocks: COMPOSIO_CALENDAR_FOLLOWUP_MOCKS,
    validationCriteria: [
      {
        id: 'did-not-search',
        description: 'Did NOT use search_integrations (tools already available from context)',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'search_integrations') && !delegatedTo(r, 'integration'),
      },
      {
        id: 'used-create-event',
        description: 'Called GOOGLECALENDAR_CREATE_EVENT tool directly',
        points: 30,
        phase: 'execution',
        validate: (r) => usedToolInFinalTurn(r, 'GOOGLECALENDAR_CREATE_EVENT'),
      },
      {
        id: 'create-event-has-details',
        description: 'CREATE_EVENT call includes event details',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'GOOGLECALENDAR_CREATE_EVENT', 'Team Sync') || toolCallArgsContain(r, 'GOOGLECALENDAR_CREATE_EVENT', 'team sync') || toolCallArgsContain(r, 'GOOGLECALENDAR_CREATE_EVENT', 'sync'),
      },
      {
        id: 'response-confirms-created',
        description: 'Response confirms the event was created',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'team sync') || responseContains(r, 'created') || responseContains(r, 'scheduled'),
      },
      {
        id: 'efficient-tool-use',
        description: 'Completed in <= 4 tool calls (no rediscovery needed)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 4,
      },
    ],
    antiPatterns: [
      'Agent re-searched for Calendar despite having it from previous turn',
      'Agent re-installed Composio unnecessarily',
    ],
  },

  // =========================================================================
  // Case 9: Multi-skill — Gmail + Calendar in one session
  // Level 4 | Two Composio integrations, both via MULTI_EXECUTE
  // =========================================================================
  {
    id: 'composio-multi-skill',
    name: 'Composio: Multi-skill — Gmail + Calendar in one session',
    category: 'mcp-discovery',
    level: 4,
    input: 'Check my Gmail for any emails from John about the budget, then create a Google Calendar event for our budget review meeting tomorrow at 3pm',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(COMPOSIO_GMAIL_CALENDAR_MULTI_MOCKS, PURE_TOOL_CALL_HIDES),
    validationCriteria: [
      {
        id: 'discovered-integrations',
        description: 'Used search_integrations to find integrations',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'installed-composio',
        description: 'Installed Composio via connect',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'fetched-emails',
        description: 'Called GMAIL_FETCH_EMAILS tool directly',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GMAIL_FETCH_EMAILS'),
      },
      {
        id: 'created-event',
        description: 'Called GOOGLECALENDAR_CREATE_EVENT tool directly',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_CREATE_EVENT'),
      },
      {
        id: 'at-least-two-tool-types',
        description: 'Used at least one Gmail and one Calendar tool',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const hasGmail = r.toolCalls.some(t => t.name.startsWith('GMAIL_'))
          const hasCalendar = r.toolCalls.some(t => t.name.startsWith('GOOGLECALENDAR_'))
          return hasGmail && hasCalendar
        },
      },
      {
        id: 'response-mentions-emails',
        description: 'Response mentions the budget emails from John',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'budget') || responseContains(r, 'john'),
      },
      {
        id: 'response-mentions-event',
        description: 'Response mentions the created calendar event',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'event') || responseContains(r, 'meeting') || responseContains(r, 'scheduled') || responseContains(r, 'created'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
    antiPatterns: [
      'Agent only handled one of the two tasks (email or calendar)',
      'Agent used npm MCP servers instead of Composio',
    ],
  },

  // =========================================================================
  // Case 10: Wrong skill loaded — agent falls through to search
  // Level 3 | Pre-loaded calendar skill but user asks about email
  // =========================================================================
  {
    id: 'composio-wrong-skill-fallthrough',
    name: 'Composio: Wrong skill loaded — falls through to search',
    category: 'mcp-discovery',
    level: 3,
    input: 'Send an email to alice@example.com about the project deadline being moved to Friday',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(COMPOSIO_GMAIL_SEND_MOCKS, PURE_TOOL_CALL_HIDES),
    workspaceFiles: {
      'skills/google-calendar.md': `---
name: google-calendar
version: 1.0.0
description: List and manage Google Calendar events.
trigger: "google calendar|calendar events|my meetings|my schedule|upcoming events"
tools: [GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS, GOOGLECALENDAR_CREATE_EVENT, connect]
---
# Google Calendar

## Setup
1. connect({ name: "googlecalendar" })

## Available Tools
- GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS — List events
- GOOGLECALENDAR_CREATE_EVENT — Create event
`,
    },
    validationCriteria: [
      {
        id: 'did-search',
        description: 'Used search_integrations since no email skill was loaded',
        points: 25,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'search_integrations'),
      },
      {
        id: 'installed-composio',
        description: 'Installed Composio for Gmail',
        points: 15,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'connect'),
      },
      {
        id: 'used-gmail-send',
        description: 'Called GMAIL_SEND_EMAIL tool directly',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GMAIL_SEND_EMAIL'),
      },
      {
        id: 'send-has-content',
        description: 'GMAIL_SEND_EMAIL call includes relevant content',
        points: 15,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'GMAIL_SEND_EMAIL', 'alice') || toolCallArgsContain(r, 'GMAIL_SEND_EMAIL', 'deadline') || toolCallArgsContain(r, 'GMAIL_SEND_EMAIL', 'Friday'),
      },
      {
        id: 'response-confirms-sent',
        description: 'Response confirms the email was sent',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'sent') || responseContains(r, 'email') || responseContains(r, 'delivered'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
    antiPatterns: [
      'Agent tried to use the calendar skill for an email request',
      'Agent did not search for an email integration',
    ],
  },

  // =========================================================================
  // Case 11 (WS9): Auth-expired error surfacing — relay reconnect, don't loop
  // Level 3 | Tool is connected but fails with a classified auth error.
  // Prod signature: integration calls fail upstream (expired OAuth) and the
  // agent either swallows it or retries the dead call instead of telling the
  // user to reconnect.
  // =========================================================================
  {
    id: 'composio-auth-error-surface',
    name: 'Composio: Surface reconnect on expired-auth error (no loop)',
    category: 'mcp-discovery',
    level: 3,
    tags: ['prod:integration-error-surfacing'],
    // Gmail is already connected from a prior turn, so the agent goes straight
    // to the send — which fails with an expired-OAuth error.
    conversationHistory: [
      { role: 'user', content: 'Connect my Gmail so you can send mail for me.' },
      { role: 'assistant', content: 'Your Gmail integration is connected. I can send emails on your behalf now.' },
    ],
    input: 'Email john@example.com with subject "Status" and body "All on track for Friday."',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(COMPOSIO_AUTH_ERROR_MOCKS, PURE_TOOL_CALL_HIDES),
    validationCriteria: [
      {
        id: 'attempted-send',
        description: 'Attempted the Gmail send (so it hit the auth error)',
        points: 15,
        phase: 'execution',
        validate: (r) => usedToolAnywhere(r, 'GMAIL_SEND_EMAIL'),
      },
      {
        id: 'surfaced-reconnect',
        description: 'Response tells the user to reconnect / re-authorize Gmail',
        points: 35,
        phase: 'execution',
        validate: (r) => surfacesReconnectGuidance(r),
      },
      {
        id: 'did-not-claim-sent',
        description: 'Did NOT falsely claim the email was sent',
        points: 25,
        phase: 'execution',
        validate: (r) =>
          !(responseContains(r, 'sent') || responseContains(r, 'delivered') || responseContains(r, 'successfully')),
      },
      {
        id: 'did-not-loop',
        description: 'Did not hammer the failing tool (<= 2 send attempts)',
        points: 25,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'GMAIL_SEND_EMAIL') <= 2,
      },
    ],
    antiPatterns: [
      'Agent retried GMAIL_SEND_EMAIL repeatedly against the same expired auth',
      'Agent claimed the email was sent despite the auth error',
      'Agent gave no actionable next step (reconnect)',
    ],
  },

  // =========================================================================
  // Case 12 (WS9): Not-found slug — self-correct to a valid bound tool
  // Level 3 | Agent guesses a dead slug; the classified error lists the valid
  // bound tools. The agent should switch to the valid tool, not loop on the
  // phantom one. Prod signature: YouTube upload calls 404 on a wrong slug.
  // =========================================================================
  {
    id: 'composio-notfound-self-correct',
    name: 'Composio: Recover from a not-found slug via the bound alternative',
    category: 'mcp-discovery',
    level: 3,
    tags: ['prod:integration-error-surfacing'],
    conversationHistory: [
      { role: 'user', content: 'Connect YouTube so you can upload videos for me.' },
      { role: 'assistant', content: 'YouTube is connected. I can upload videos for you now.' },
    ],
    input:
      'Upload the file at uploads/demo.mp4 to YouTube with the title "Product Demo". If the first tool you try is not available, use the correct YouTube upload tool that is.',
    maxScore: 100,
    toolMocks: withHiddenNativeTools(COMPOSIO_NOTFOUND_ERROR_MOCKS, PURE_TOOL_CALL_HIDES),
    validationCriteria: [
      {
        id: 'used-valid-upload-tool',
        description: 'Called the valid bound upload tool (YOUTUBE_MULTIPART_UPLOAD_VIDEO)',
        points: 40,
        phase: 'execution',
        validate: (r) => usedToolAnywhere(r, 'YOUTUBE_MULTIPART_UPLOAD_VIDEO'),
      },
      {
        id: 'did-not-loop-dead-slug',
        description: 'Did not repeatedly call the dead slug (<= 2 attempts)',
        points: 30,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'YOUTUBE_UPLOAD_VIDEO') <= 2,
      },
      {
        id: 'response-confirms-upload',
        description: 'Response reflects a successful upload (or accurate status)',
        points: 30,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'upload') || responseContains(r, 'uploaded') || responseContains(r, 'youtube'),
      },
    ],
    antiPatterns: [
      'Agent looped calling the unavailable YOUTUBE_UPLOAD_VIDEO slug',
      'Agent gave up without trying the valid bound tool listed in the error hint',
    ],
  },
]
