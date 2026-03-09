// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Response Transform Eval Test Cases
 *
 * Tests the agent's ability to:
 * 1. Recognize truncated tool responses and create transforms to fix them
 * 2. Use pre-loaded transforms from disk (no re-creation needed)
 * 3. Test transforms before relying on them
 * 4. Handle broken transforms gracefully (fallback to truncated)
 */

import type { AgentEval } from './types'
import {
  RESPONSE_TRANSFORM_LARGE_ISSUES_MOCKS,
  RESPONSE_TRANSFORM_PRELOADED_MOCKS,
  RESPONSE_TRANSFORM_FALLBACK_MOCKS,
} from './tool-mocks'
import {
  usedTool,
  neverUsedTool,
  responseContains,
  toolCallArgsContain,
  toolCallCount,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const RESPONSE_TRANSFORM_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Agent creates transform after seeing truncated response
  // Level 3 | Full flow: call tool → see truncation → create transform → re-call
  // =========================================================================
  {
    id: 'response-transform-create-after-truncation',
    name: 'Response Transform: Create after truncated response',
    category: 'tool-system',
    level: 3,
    input: 'Show me all the open issues on GitHub for the acme/app repo. I need the issue number, title, state, and labels for each one.',
    maxScore: 100,
    toolMocks: RESPONSE_TRANSFORM_LARGE_ISSUES_MOCKS,
    validationCriteria: [
      {
        id: 'installed-github',
        description: 'Installed GitHub via Composio',
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
        id: 'created-transform',
        description: 'Used binding_transform to create a response transform',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'binding_transform') &&
          r.toolCalls.some(t =>
            t.name === 'binding_transform' &&
            (t.input as any)?.action === 'create',
          ),
      },
      {
        id: 'transform-targets-issues',
        description: 'Transform targets GITHUB_LIST_ISSUES tool',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'binding_transform', 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'transform-extracts-fields',
        description: 'Transform function extracts title, state, or labels',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const transformCall = r.toolCalls.find(
            t => t.name === 'binding_transform' && (t.input as any)?.action === 'create',
          )
          if (!transformCall) return false
          const fn = ((transformCall.input as any)?.transform || '').toLowerCase()
          return fn.includes('title') || fn.includes('state') || fn.includes('label')
        },
      },
      {
        id: 're-called-after-transform',
        description: 'Re-called GITHUB_LIST_ISSUES after creating the transform',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const calls = r.toolCalls.map(t => t.name)
          const transformIdx = calls.indexOf('binding_transform')
          const lastIssuesIdx = calls.lastIndexOf('GITHUB_LIST_ISSUES')
          return transformIdx >= 0 && lastIssuesIdx > transformIdx
        },
      },
      {
        id: 'response-has-issues',
        description: 'Final response mentions specific issues',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'login') ||
          responseContains(r, 'memory leak') ||
          responseContains(r, 'dark mode') ||
          responseContains(r, 'issue'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
    antiPatterns: [
      'Agent did not attempt to create a transform despite seeing truncated response',
      'Agent created a transform but did not re-call the tool',
    ],
  },

  // =========================================================================
  // Case 2: Transform already exists — agent uses it directly
  // Level 2 | Pre-loaded transform in workspace; agent just calls tool
  // =========================================================================
  {
    id: 'response-transform-preloaded',
    name: 'Response Transform: Pre-loaded from disk',
    category: 'tool-system',
    level: 2,
    input: 'Show me my calendar events for this week.',
    maxScore: 100,
    toolMocks: RESPONSE_TRANSFORM_PRELOADED_MOCKS,
    workspaceFiles: {
      'transforms/GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS.json': JSON.stringify({
        toolSlug: 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
        description: 'Extract event summaries with time and location',
        transformFn: '(data) => ({ events: data.data.items.map(e => ({ id: e.id, summary: e.summary, start: e.start?.dateTime, end: e.end?.dateTime, location: e.location })), total: data.data.items.length })',
        createdAt: 1741334400000,
      }),
      'skills/google-calendar.md': `---
name: google-calendar
version: 1.0.0
description: List Google Calendar events.
trigger: "google calendar|calendar events|my meetings|my schedule|calendar"
tools: [GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS, tool_install]
---
# Google Calendar

## Setup
1. tool_install({ name: "googlecalendar" })

## Tools
- GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS — List events
`,
    },
    validationCriteria: [
      {
        id: 'called-calendar-tool',
        description: 'Called the calendar list tool',
        points: 30,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'),
      },
      {
        id: 'did-not-create-transform',
        description: 'Did NOT create a new transform (one was pre-loaded)',
        points: 25,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'binding_transform') ||
          !r.toolCalls.some(t =>
            t.name === 'binding_transform' &&
            (t.input as any)?.action === 'create',
          ),
      },
      {
        id: 'response-has-events',
        description: 'Response mentions calendar events',
        points: 25,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'standup') ||
          responseContains(r, 'review') ||
          responseContains(r, 'meeting') ||
          responseContains(r, 'event'),
      },
      {
        id: 'efficient-tool-use',
        description: 'Completed in <= 5 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 5,
      },
    ],
    antiPatterns: [
      'Agent created a new transform despite one being pre-loaded from disk',
      'Agent failed to retrieve calendar data',
    ],
  },

  // =========================================================================
  // Case 3: Agent tests transform before relying on it
  // Level 3 | Create transform → test it → verify size reduction
  // =========================================================================
  {
    id: 'response-transform-test-action',
    name: 'Response Transform: Test action verifies size reduction',
    category: 'tool-system',
    level: 3,
    input: 'List all issues from GitHub for acme/app. I need a compact summary — just the issue number, title, and current state. Make sure the response is not truncated.',
    maxScore: 100,
    toolMocks: RESPONSE_TRANSFORM_LARGE_ISSUES_MOCKS,
    validationCriteria: [
      {
        id: 'called-list-issues',
        description: 'Called GITHUB_LIST_ISSUES',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'created-transform',
        description: 'Created a binding_transform',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'binding_transform' &&
          (t.input as any)?.action === 'create',
        ),
      },
      {
        id: 'tested-transform',
        description: 'Used binding_transform test action to verify the transform',
        points: 25,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'binding_transform' &&
          (t.input as any)?.action === 'test',
        ),
      },
      {
        id: 'response-mentions-issues',
        description: 'Response mentions specific issues',
        points: 15,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'login') ||
          responseContains(r, 'dark mode') ||
          responseContains(r, 'issue'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
      {
        id: 're-called-tool',
        description: 'Re-called GITHUB_LIST_ISSUES after creating transform',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'GITHUB_LIST_ISSUES') >= 2,
      },
    ],
    antiPatterns: [
      'Agent created a transform but never tested or re-called the tool',
      'Agent did not notice the response was truncated',
    ],
  },

  // =========================================================================
  // Case 4: Broken transform — graceful fallback
  // Level 2 | Pre-loaded broken transform → still gets data (via truncation)
  // =========================================================================
  {
    id: 'response-transform-fallback',
    name: 'Response Transform: Graceful fallback on broken transform',
    category: 'tool-system',
    level: 2,
    input: 'Show me the open issues on GitHub for acme/app.',
    maxScore: 100,
    toolMocks: RESPONSE_TRANSFORM_FALLBACK_MOCKS,
    workspaceFiles: {
      'transforms/GITHUB_LIST_ISSUES.json': JSON.stringify({
        toolSlug: 'GITHUB_LIST_ISSUES',
        description: 'Broken transform that will throw',
        transformFn: '(data) => data.nonexistent.property.deep.access',
        createdAt: 1741334400000,
      }),
    },
    validationCriteria: [
      {
        id: 'called-list-issues',
        description: 'Called GITHUB_LIST_ISSUES',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'response-has-data',
        description: 'Response still contains issue data despite broken transform',
        points: 35,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'login') ||
          responseContains(r, 'dark mode') ||
          responseContains(r, 'memory') ||
          responseContains(r, 'issue'),
      },
      {
        id: 'no-error-surfaced',
        description: 'No transform error surfaced to the user',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          !responseContains(r, 'transform failed') &&
          !responseContains(r, 'transform error'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 8 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
    antiPatterns: [
      'Agent surfaced a transform error to the user',
      'Agent was unable to retrieve any issue data',
    ],
  },
]
