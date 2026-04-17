// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Complex Multi-Tool Eval Test Cases — Canvas V2 (Code Mode)
 *
 * These test cases exercise advanced agentic patterns in Code Mode:
 * - Multi-file React apps (multiple components for different views)
 * - web -> code (pull live data and render it in React components)
 * - MCP integration -> code (external services populate dashboards)
 * - Memory persistence (store findings for later recall)
 * - Cross-tool orchestration (combining exec, web, MCP, write_file, messaging)
 * - Verification via read_file / read_lint
 *
 * All external tools are mocked via the tool-mocks infrastructure so these
 * evals run fast, deterministically, and without credentials.
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  COMPETITIVE_INTEL_MOCKS,
  GITHUB_TRIAGE_MOCKS,
  NEWS_BRIEF_MOCKS,
  API_HEALTH_MOCKS,
  SENTRY_TRIAGE_MOCKS,
  MEETING_PREP_MOCKS,
  STRIPE_REVENUE_MOCKS,
  PR_REVIEW_MOCKS,
} from './tool-mocks'
import { usedTool, usedToolAnywhere, neverUsedTool, toolCallCount, responseContains, toolCallsJson } from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared V2 config — canvasMode: 'code' + activeMode: 'canvas'
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
// Validation helpers (Code Mode)
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function wroteCodeFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!isCodeFile(path)) return false
    return namePattern ? namePattern.test(path) : true
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

function anyCodeContains(r: EvalResult, term: string): boolean {
  return allWrittenCode(r).includes(term.toLowerCase())
}

function codeFileCount(r: EvalResult): number {
  const paths = new Set<string>()
  for (const t of r.toolCalls) {
    if (t.name !== 'write_file') continue
    const path = String((t.input as any).path ?? '')
    if (isCodeFile(path)) paths.add(path)
  }
  return paths.size
}

function wroteSchema(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    return path.includes('schema.prisma')
  })
}

function neverUsedV1CanvasTools(_r: EvalResult): boolean {
  return true
}

function wroteMemoryFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    return path.includes('memory') || path.includes('.shogo') || path.includes('notes') || path.includes('log')
  })
}

function usedVerification(r: EvalResult): boolean {
  return usedTool(r, 'read_file') || usedTool(r, 'read_lint')
}

// Merge skill-server passthrough mocks with eval-specific mocks
function withSkillServerMocks(evalMocks: ToolMockMap): ToolMockMap {
  return {
    ...evalMocks,
    exec: evalMocks.exec ?? { type: 'static', response: 'Done.' },
  }
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const COMPLEX_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Competitive Intelligence Dashboard
  // Level 4 | web + multi-file React + memory | Multi-turn
  // =========================================================================
  {
    id: 'complex-competitive-intel',
    name: 'Complex: Competitive intelligence dashboard',
    category: 'complex',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      { role: 'user', content: 'I want to track our competitors — Vercel, Netlify, and Render. Can you keep an eye on their pricing and features for me?' },
    ],
    input: 'Great — go ahead and fetch their current pricing pages, store what you find in your memory, and build me two dashboard views: one with a side-by-side pricing comparison table showing plan costs and key limits, and another with a feature matrix showing what each provider offers (checkmarks or yes/no). Write React components for both views and make sure everything renders correctly.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(COMPETITIVE_INTEL_MOCKS),
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web at least 3 times (one per competitor)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 3,
      },
      {
        id: 'wrote-multiple-components',
        description: 'Wrote at least 2 src/*.tsx files (multi-view)',
        points: 10,
        phase: 'intention',
        validate: (r) => codeFileCount(r) >= 2,
      },
      {
        id: 'used-write-file-memory',
        description: 'Used write_file to store findings to memory',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteMemoryFile(r),
      },
      {
        id: 'has-all-companies',
        description: 'Code references all 3 companies',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('vercel') && code.includes('netlify') && code.includes('render')
        },
      },
      {
        id: 'has-pricing-data',
        description: 'Has pricing data ($20, $19, $25 or similar)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('20') || code.includes('19') || code.includes('25')
        },
      },
      {
        id: 'has-table-jsx',
        description: 'Has table or grid component in JSX',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('<table') || code.includes('<tr') || code.includes('grid') || code.includes('<td')
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
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedVerification(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch competitor data', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 2: GitHub Issue Triage Board
  // Level 4 | MCP GitHub + React code + skill server schema
  // =========================================================================
  {
    id: 'complex-github-triage',
    name: 'Complex: GitHub issue triage board',
    category: 'complex',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    input: 'I need a triage board for my GitHub issues in the acme-corp/webapp repository. Pull the open issues using the GitHub integration (use GITHUB_LIST_ISSUES), categorize them by severity (Critical, High, Medium, Low based on their labels), and build me a React dashboard with the issues organized by severity columns. Set up a Prisma schema for persisting issue data with a status field, and write the components so I can see all issues at a glance. Verify everything looks good.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(GITHUB_TRIAGE_MOCKS),
    validationCriteria: [
      {
        id: 'used-github-issues',
        description: 'Used GITHUB_LIST_ISSUES to fetch issues',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'wrote-src-file',
        description: 'Wrote at least one src/*.tsx component',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'wrote-schema',
        description: 'Wrote a Prisma schema for issue data',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteSchema(r),
      },
      {
        id: 'has-severity-categorization',
        description: 'Code has severity categorization (critical, high, medium, low)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('critical') || code.includes('p0')) &&
                 (code.includes('high') || code.includes('medium') || code.includes('low'))
        },
      },
      {
        id: 'has-issue-data',
        description: 'Code references issue data from mock (login bug, API timeout, etc.)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('login') || json.includes('api') || json.includes('bug')
        },
      },
      {
        id: 'has-status-field',
        description: 'Schema or code includes a status field for tracking',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = `${allWrittenCode(r)}\n${toolCallsJson(r)}`
          return all.includes('status')
        },
      },
      {
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedVerification(r),
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
        description: 'Completed in <= 35 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 35,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch GitHub issues', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 3: Daily News Research Brief
  // Level 4 | web + React code + memory + write_file | Multi-turn
  // =========================================================================
  {
    id: 'complex-news-brief',
    name: 'Complex: Daily news research brief',
    category: 'complex',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      { role: 'user', content: 'I want a daily brief on AI infrastructure news.' },
    ],
    input: 'Focus on these topics: GPU cloud pricing, open-source LLM releases, and inference optimization. Check TechCrunch, The Verge, and Hacker News for the latest. Fetch each source, store a summary in your memory as a daily log, and build me a React dashboard with: a "Key Takeaways" section at the top, a table of all the articles (title, source, summary), and a topic distribution breakdown. Set up a Prisma schema for the articles so they can be tracked. Verify everything looks correct.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(NEWS_BRIEF_MOCKS),
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web at least 3 times (one per source)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 3,
      },
      {
        id: 'used-write-file-memory',
        description: 'Used write_file to log the daily brief to memory',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteMemoryFile(r),
      },
      {
        id: 'wrote-src-file',
        description: 'Wrote at least one src/*.tsx component',
        points: 5,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'has-article-table',
        description: 'Code has a table or list for articles',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('<table') || code.includes('<tr') || code.includes('<li') || code.includes('.map(')
        },
      },
      {
        id: 'references-sources',
        description: 'Code references multiple news sources',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          const sources = [code.includes('techcrunch'), code.includes('verge'), code.includes('ycombinator') || code.includes('hacker')]
          return sources.filter(Boolean).length >= 2
        },
      },
      {
        id: 'wrote-schema',
        description: 'Wrote a Prisma schema for article data',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteSchema(r),
      },
      {
        id: 'has-key-takeaways',
        description: 'Code has a key takeaways or summary section',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('takeaway') || code.includes('summary') || code.includes('highlight') || code.includes('key ')
        },
      },
      {
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedVerification(r),
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
        description: 'Completed in <= 22 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 22,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch news sources', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 4: API Health Monitor
  // Level 4 | web + multi-file React + data display
  // =========================================================================
  {
    id: 'complex-api-health',
    name: 'Complex: API health monitor dashboard',
    category: 'complex',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    input: 'Monitor these 3 API endpoints and show me a status dashboard:\n- https://api.example.com/health (production)\n- https://api.staging.example.com/health (staging)\n- https://api.internal.example.com/health (internal)\n\nFetch each endpoint to get their health status, then build a React dashboard with: a status page with green/red indicators per endpoint and uptime metrics, plus a section showing response time data. Write the components to src/ and verify they render without lint errors.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(API_HEALTH_MOCKS),
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web at least 3 times (one per endpoint)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 3,
      },
      {
        id: 'wrote-multiple-components',
        description: 'Wrote at least 2 src/*.tsx files',
        points: 10,
        phase: 'intention',
        validate: (r) => codeFileCount(r) >= 2,
      },
      {
        id: 'has-status-indicators',
        description: 'Code has status indicators (healthy/degraded/down or green/red)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('healthy') || code.includes('green') || code.includes('degraded') || code.includes('status'))
        },
      },
      {
        id: 'has-response-time',
        description: 'Code has response time data (45, 230, latency, etc.)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('responsetime') || code.includes('response_time') || code.includes('latency') || code.includes('45') || code.includes('230')
        },
      },
      {
        id: 'has-uptime-metrics',
        description: 'Code has uptime or metric display',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('uptime') || code.includes('99.9') || code.includes('%')
        },
      },
      {
        id: 'references-all-endpoints',
        description: 'Code references production, staging, and internal',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('production') || code.includes('prod')) &&
                 (code.includes('staging') || code.includes('stag')) &&
                 (code.includes('internal') || code.includes('intern'))
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
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedVerification(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch API endpoints', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 5: Sentry Error Triage + Fix Tracker
  // Level 4 | MCP Sentry + React code + memory
  // =========================================================================
  {
    id: 'complex-sentry-triage',
    name: 'Complex: Sentry error triage + fix tracker',
    category: 'complex',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    input: 'Pull the top errors from Sentry using the Sentry integration and build me a triage tracker. I need a React component with a table where each error shows its title, occurrence count, last seen date, and a status field (New/Investigating/Fixed). Set up a Prisma schema for persisting error triage data. Write the code with proper state management so status can be toggled. Verify the code is lint-free, and log the triage session to your memory.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(SENTRY_TRIAGE_MOCKS),
    validationCriteria: [
      {
        id: 'used-sentry-issues',
        description: 'Used SENTRY_LIST_ISSUES to fetch errors',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'SENTRY_LIST_ISSUES'),
      },
      {
        id: 'wrote-src-file',
        description: 'Wrote at least one src/*.tsx component',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'wrote-schema',
        description: 'Wrote a Prisma schema with status field',
        points: 10,
        phase: 'intention',
        validate: (r) => {
          if (!wroteSchema(r)) return false
          const json = toolCallsJson(r)
          return json.includes('status')
        },
      },
      {
        id: 'has-error-table',
        description: 'Code has a table with error title, count, last seen, status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('<table') || code.includes('<tr') || code.includes('.map(')) && code.includes('count')
        },
      },
      {
        id: 'has-status-management',
        description: 'Code has state management for status (useState, onClick, etc.)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('usestate') || code.includes('setstate') || code.includes('onclick') || code.includes('onchange'))
        },
      },
      {
        id: 'has-status-values',
        description: 'Code includes status values (New, Investigating, Fixed)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('new') || code.includes('investigating') || code.includes('fixed'))
        },
      },
      {
        id: 'used-write-file-memory',
        description: 'Logged triage action to memory via write_file',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteMemoryFile(r),
      },
      {
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify code',
        points: 15,
        phase: 'execution',
        validate: (r) => usedVerification(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch Sentry errors', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 6: Meeting Prep Command Center
  // Level 5 | MCP Google Calendar + web + multi-file React
  // =========================================================================
  {
    id: 'complex-meeting-prep',
    name: 'Complex: Meeting prep command center',
    category: 'complex',
    level: 5,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    input: 'Prepare me for my meetings today. Use the Google Calendar integration to get my schedule, then research each external attendee\'s company by fetching their website. Build two React components: one showing today\'s schedule as a timeline with meeting titles, times, and attendees, and another with research cards for each company — what they do, their size, and recent news. Write prep notes to your memory. Verify the code.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(MEETING_PREP_MOCKS),
    validationCriteria: [
      {
        id: 'used-calendar',
        description: 'Used GOOGLECALENDAR_FIND_EVENT',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_FIND_EVENT'),
      },
      {
        id: 'used-web-fetch',
        description: 'Used web at least 2 times for company research',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 2,
      },
      {
        id: 'wrote-multiple-components',
        description: 'Wrote at least 2 src/*.tsx files (schedule + research)',
        points: 10,
        phase: 'intention',
        validate: (r) => codeFileCount(r) >= 2,
      },
      {
        id: 'has-schedule-data',
        description: 'Code has meeting schedule (planning, partnership, demo)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('q1 planning') || code.includes('planning')) &&
                 (code.includes('partnership') || code.includes('demo'))
        },
      },
      {
        id: 'has-company-research',
        description: 'Code has attendee/company research cards',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('acme') || code.includes('partnerco') || code.includes('vcfirm')
        },
      },
      {
        id: 'used-write-file-memory',
        description: 'Wrote prep notes to memory via write_file',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteMemoryFile(r),
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 5,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedVerification(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch calendar events', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 7: Stripe Revenue Dashboard + Invoice Manager
  // Level 5 | MCP Stripe + React code + skill server schema | Multi-turn
  // =========================================================================
  {
    id: 'complex-stripe-revenue',
    name: 'Complex: Stripe revenue dashboard + invoice manager',
    category: 'complex',
    level: 5,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      { role: 'user', content: 'I need to see my Stripe revenue and manage invoices.' },
    ],
    input: 'My MRR is about $12,500 from 180 customers. Install the Stripe integration (tool_install stripe), then use STRIPE_RETRIEVE_BALANCE to get my current balance and STRIPE_LIST_CHARGES to pull recent payments. Build me a React dashboard with: revenue metrics at the top (MRR, balance, pending, customer count), a table of recent payments, and an invoice management section with a form to create new invoices (client, amount, status, due date). Set up a Prisma schema for invoices. Use proper React state for the form. Verify everything is lint-free and log the revenue snapshot to memory.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(STRIPE_REVENUE_MOCKS),
    validationCriteria: [
      {
        id: 'used-stripe-tools',
        description: 'Used at least one Stripe MCP tool',
        points: 10,
        phase: 'intention',
        validate: (r) =>
          usedTool(r, 'STRIPE_GET_BALANCE') || usedTool(r, 'STRIPE_RETRIEVE_BALANCE') ||
          usedTool(r, 'STRIPE_LIST_PAYMENTS') || usedTool(r, 'STRIPE_LIST_CHARGES'),
      },
      {
        id: 'wrote-src-file',
        description: 'Wrote at least one src/*.tsx component',
        points: 5,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'wrote-schema',
        description: 'Wrote a Prisma schema for invoice model',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteSchema(r),
      },
      {
        id: 'has-revenue-metrics',
        description: 'Code has revenue metrics (MRR, balance, customers)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('mrr') || code.includes('revenue') || code.includes('12,500') || code.includes('12500')) &&
                 (code.includes('balance') || code.includes('customer'))
        },
      },
      {
        id: 'has-payments-table',
        description: 'Code has a table for recent payments',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('<table') || code.includes('<tr') || code.includes('.map(')) && code.includes('payment')
        },
      },
      {
        id: 'has-invoice-form',
        description: 'Code has a form with state management for invoices',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('<form') || code.includes('<input') || code.includes('onsubmit') || code.includes('handlesubmit')) &&
                 (code.includes('usestate') || code.includes('onchange'))
        },
      },
      {
        id: 'used-write-file-memory',
        description: 'Logged revenue snapshot to memory via write_file',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteMemoryFile(r),
      },
      {
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 10,
        phase: 'execution',
        validate: (r) => usedVerification(r),
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
        description: 'Completed in <= 35 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 35,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch Stripe data', 'Used V1 canvas tools instead of file tools'],
  },

  // =========================================================================
  // Case 8: Multi-Repo PR Review Queue
  // Level 5 | MCP GitHub + web + React code + send_message
  // =========================================================================
  {
    id: 'complex-pr-review-queue',
    name: 'Complex: Multi-repo PR review queue',
    category: 'complex',
    level: 5,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    input: 'I manage 3 repos under the acme-corp GitHub org: acme-corp/frontend, acme-corp/backend, and acme-corp/infra. Use the GitHub integration (GITHUB_LIST_PULL_REQUESTS) to pull open PRs from each repo. Build me a unified PR review queue in React with a table showing: repo name, PR title, author, CI status, and age. Add action buttons for "Approve" and "Request Changes" with proper click handlers. For any PR that\'s been open more than 2 days with no review, send a Discord alert using send_message (channel: #pr-alerts). Set up a Prisma schema for tracking PR reviews. Verify the code.',
    maxScore: 100,
    toolMocks: withSkillServerMocks(PR_REVIEW_MOCKS),
    validationCriteria: [
      {
        id: 'used-github-multi',
        description: 'Used GITHUB_LIST_ISSUES or GITHUB_LIST_PULL_REQUESTS at least 2 times (multi-repo)',
        points: 10,
        phase: 'intention',
        validate: (r) => (toolCallCount(r, 'GITHUB_LIST_ISSUES') + toolCallCount(r, 'GITHUB_LIST_PULL_REQUESTS')) >= 2,
      },
      {
        id: 'wrote-src-file',
        description: 'Wrote at least one src/*.tsx component',
        points: 5,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'wrote-schema',
        description: 'Wrote a Prisma schema for PR review tracking',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteSchema(r),
      },
      {
        id: 'has-pr-data-multi-repo',
        description: 'Code references PRs from multiple repos',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          const repos = [code.includes('frontend'), code.includes('backend'), code.includes('infra')]
          return repos.filter(Boolean).length >= 2
        },
      },
      {
        id: 'has-table-with-fields',
        description: 'Code has a table with PR title, repo, author, CI status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('<table') || code.includes('<tr') || code.includes('.map('))
        },
      },
      {
        id: 'has-action-buttons',
        description: 'Code has approve / request changes buttons with handlers',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('approve') || code.includes('request')) &&
                 (code.includes('onclick') || code.includes('button') || code.includes('<button'))
        },
      },
      {
        id: 'used-send-message',
        description: 'Used send_message for stale PR alert',
        points: 10,
        phase: 'execution',
        validate: (r) => usedToolAnywhere(r, 'send_message'),
      },
      {
        id: 'used-verification',
        description: 'Used read_file or read_lint to verify',
        points: 10,
        phase: 'execution',
        validate: (r) => usedVerification(r),
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
        description: 'Completed in <= 35 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 35,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch PRs from GitHub', 'Used V1 canvas tools instead of file tools'],
  },
]
