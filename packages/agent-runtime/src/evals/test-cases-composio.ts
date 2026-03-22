// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Composio Integration Eval Test Cases
 *
 * Tests the agent's ability to discover, install, and use Composio-backed
 * integrations (Google Calendar, Gmail, GitHub, etc.) via the tool_search →
 * tool_install → direct toolkit tool calls flow.
 *
 * tool_install now registers individual proxy tools (e.g. GOOGLECALENDAR_LIST_EVENTS)
 * and handles auth automatically. The agent calls tools directly, not via meta-tools.
 *
 * Also tests:
 * - Composio preference over local/npm MCP servers
 * - Skill-based shortcutting (skip discovery when skill exists)
 * - Auth flow handling (tool_install returns authUrl)
 * - Write operations (sending emails)
 */

import type { AgentEval } from './types'
import {
  COMPOSIO_GOOGLE_CALENDAR_MOCKS,
  COMPOSIO_PREFERENCE_MOCKS,
  COMPOSIO_AUTH_REQUIRED_MOCKS,
  COMPOSIO_GMAIL_SEND_MOCKS,
  COMPOSIO_GITHUB_PR_SKILL_SAVE_MOCKS,
  AIRBNB_SKILL_SAVE_MOCKS,
  COMPOSIO_CALENDAR_FOLLOWUP_MOCKS,
  COMPOSIO_GMAIL_CALENDAR_MULTI_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  usedToolInFinalTurn,
  neverUsedTool,
  toolCallCount,
  responseContains,
  toolCallArgsContain,
  installCalledWithoutCommand,
} from './eval-helpers'

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
        description: 'Used tool_search to find Google Calendar',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Used tool_install to connect Composio integration',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'install-no-command',
        description: 'tool_install called without command/args (Composio needs only name)',
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
        description: 'Used tool_search to find GitHub',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Used tool_install (for Composio, not npm)',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'install-composio-name',
        description: 'tool_install used Composio toolkit name (no command/args)',
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
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
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
      'Agent passed command or args to tool_install for a Composio integration',
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
    toolMocks: {
      ...COMPOSIO_GOOGLE_CALENDAR_MOCKS,
    },
    workspaceFiles: {
      'skills/google-calendar.md': `---
name: google-calendar
version: 1.0.0
description: List Google Calendar events for a specified time range.
trigger: "google calendar|calendar events|my meetings|my schedule|upcoming events|weekly calendar|show my calendar|list meetings|meetings|calendar"
tools: [GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS, GOOGLECALENDAR_CREATE_EVENT, tool_install]
---
# Google Calendar

This skill provides everything needed — do NOT call tool_search.

## Setup
1. Ensure Composio is connected: tool_install({ name: "googlecalendar" })
   (Auth is checked automatically by tool_install)

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
        description: 'Did NOT use tool_search at all (skill provides the info)',
        points: 25,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'tool_search'),
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
        description: 'Still called tool_install to ensure Composio is connected',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'tool_install'),
      },
    ],
    antiPatterns: [
      'Agent searched for Google Calendar despite having a loaded skill',
    ],
  },

  // =========================================================================
  // Case 4: Auth flow — not yet connected
  // Level 2 | tool_install returns authStatus: 'needs_auth' + authUrl → agent shows URL
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
        description: 'Used tool_search to find Gmail',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Used tool_install for Gmail (returns authUrl)',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'showed-auth-url',
        description: 'Response includes the auth/connect URL from tool_install',
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
    toolMocks: COMPOSIO_GMAIL_SEND_MOCKS,
    validationCriteria: [
      {
        id: 'searched-for-gmail',
        description: 'Used tool_search to find Gmail',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Used tool_install for Gmail via Composio',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
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
    input: 'Show me my open pull requests on GitHub',
    maxScore: 100,
    toolMocks: COMPOSIO_GITHUB_PR_SKILL_SAVE_MOCKS,
    validationCriteria: [
      {
        id: 'completed-discovery',
        description: 'Completed the full Composio discovery flow',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'tool_search') && usedTool(r, 'tool_install'),
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
    input: 'Search for Airbnb listings in Bali for 2 adults, March 15-22',
    maxScore: 100,
    toolMocks: AIRBNB_SKILL_SAVE_MOCKS,
    validationCriteria: [
      {
        id: 'completed-discovery',
        description: 'Searched and installed the Airbnb MCP server',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'tool_search') && usedTool(r, 'tool_install'),
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
          return content.includes('airbnb') && content.includes('tool_install')
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
        description: 'Did NOT use tool_search (tools already available from context)',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'tool_search'),
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
    toolMocks: COMPOSIO_GMAIL_CALENDAR_MULTI_MOCKS,
    validationCriteria: [
      {
        id: 'discovered-integrations',
        description: 'Used tool_search to find integrations',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Installed Composio via tool_install',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
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
    toolMocks: COMPOSIO_GMAIL_SEND_MOCKS,
    workspaceFiles: {
      'skills/google-calendar.md': `---
name: google-calendar
version: 1.0.0
description: List and manage Google Calendar events.
trigger: "google calendar|calendar events|my meetings|my schedule|upcoming events"
tools: [GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS, GOOGLECALENDAR_CREATE_EVENT, tool_install]
---
# Google Calendar

## Setup
1. tool_install({ name: "googlecalendar" })

## Available Tools
- GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS — List events
- GOOGLECALENDAR_CREATE_EVENT — Create event
`,
    },
    validationCriteria: [
      {
        id: 'did-search',
        description: 'Used tool_search since no email skill was loaded',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-composio',
        description: 'Installed Composio for Gmail',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
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
]
