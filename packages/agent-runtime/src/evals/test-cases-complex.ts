/**
 * Complex Multi-Tool Eval Test Cases
 *
 * These test cases exercise advanced agentic patterns:
 * - Multi-canvas (multiple surfaces for different views)
 * - web -> canvas (pull live data and render it)
 * - MCP integration -> canvas (external services populate dashboards)
 * - Memory persistence (store findings for later recall)
 * - Cross-tool orchestration (combining exec, web, MCP, canvas, messaging)
 * - CRUD + verification (every case includes trigger+inspect)
 *
 * All external tools are mocked via the tool-mocks infrastructure so these
 * evals run fast, deterministically, and without credentials.
 */

import type { AgentEval } from './types'
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
import { usedTool, toolCallCount, responseContains, toolCallsJson } from './eval-helpers'

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const COMPLEX_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Competitive Intelligence Dashboard
  // Level 4 | web + multi-canvas + memory | Multi-turn
  // =========================================================================
  {
    id: 'complex-competitive-intel',
    name: 'Complex: Competitive intelligence dashboard',
    category: 'complex',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I want to track our competitors — Vercel, Netlify, and Render. Can you keep an eye on their pricing and features for me?' },
    ],
    input: 'Great — go ahead and fetch their current pricing pages, store what you find in your memory, and build me two canvas dashboards: one with a side-by-side pricing comparison table showing plan costs and key limits, and another with a feature matrix showing what each provider offers (checkmarks or yes/no). Make sure everything renders correctly.',
    maxScore: 100,
    toolMocks: COMPETITIVE_INTEL_MOCKS,
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web at least 3 times (one per competitor)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 3,
      },
      {
        id: 'used-canvas-create-multi',
        description: 'Used canvas_create at least 2 times (multi-canvas)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'canvas_create') >= 2,
      },
      {
        id: 'used-memory-write',
        description: 'Used memory_write to store findings',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'has-all-companies',
        description: 'Canvas data references all 3 companies',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('vercel') && json.includes('netlify') && json.includes('render')
        },
      },
      {
        id: 'has-pricing-data',
        description: 'Has pricing data ($20, $19, $25 or similar)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return (json.includes('20') || json.includes('19') || json.includes('25'))
        },
      },
      {
        id: 'has-table-or-metric',
        description: 'Has Table or Metric components for comparison',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"') || json.includes('"Metric"')
        },
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to build UI',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch competitor data'],
  },

  // =========================================================================
  // Case 2: GitHub Issue Triage Board
  // Level 4 | MCP GitHub + canvas + heartbeat
  // =========================================================================
  {
    id: 'complex-github-triage',
    name: 'Complex: GitHub issue triage board',
    category: 'complex',
    level: 4,
    requiredAgent: 'advanced' as const,
    input: 'I need a triage board for my GitHub issues. Pull the open issues using the GitHub integration, categorize them by severity (Critical, High, Medium, Low based on their labels), and build me a canvas dashboard with the issues organized by severity. Set up a CRUD API so I can update issue status, seed it with the fetched issues, and set up a heartbeat or cron job to periodically re-fetch. Test that I can change an issue\'s status.',
    maxScore: 100,
    toolMocks: GITHUB_TRIAGE_MOCKS,
    validationCriteria: [
      {
        id: 'used-github-issues',
        description: 'Used GITHUB_LIST_ISSUES to fetch issues',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_LIST_ISSUES'),
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define Issue model',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'has-severity-categorization',
        description: 'Canvas has severity categorization (critical, high, medium, low)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return (json.includes('critical') || json.includes('p0')) &&
                 (json.includes('high') || json.includes('medium') || json.includes('low'))
        },
      },
      {
        id: 'used-api-seed',
        description: 'Seeded issue data via canvas_api_seed',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'setup-scheduling',
        description: 'Set up heartbeat or cron for periodic refresh',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          return usedTool(r, 'cron') || usedTool(r, 'write_file')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to test status update',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch GitHub issues'],
  },

  // =========================================================================
  // Case 3: Daily News Research Brief
  // Level 4 | web + canvas + memory + write_file | Multi-turn
  // =========================================================================
  {
    id: 'complex-news-brief',
    name: 'Complex: Daily news research brief',
    category: 'complex',
    level: 4,
    requiredAgent: 'advanced' as const,
    conversationHistory: [
      { role: 'user', content: 'I want a daily brief on AI infrastructure news.' },
    ],
    input: 'Focus on these topics: GPU cloud pricing, open-source LLM releases, and inference optimization. Check TechCrunch, The Verge, and Hacker News for the latest. Fetch each source, store a summary in your memory as a daily log, and build me a canvas dashboard with: a "Key Takeaways" section at the top, a table of all the articles (title, source, summary), and a topic distribution breakdown. Set up a CRUD API for the articles so I can mark ones I\'ve read. Verify everything works.',
    maxScore: 100,
    toolMocks: NEWS_BRIEF_MOCKS,
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web at least 3 times (one per source)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 3,
      },
      {
        id: 'used-memory-write',
        description: 'Used memory_write to log the daily brief',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'has-article-table',
        description: 'Canvas has DataList or Table with articles',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"') || json.includes('"DataList"')
        },
      },
      {
        id: 'references-sources',
        description: 'Data references multiple news sources',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          const sources = [json.includes('techcrunch'), json.includes('verge'), json.includes('ycombinator') || json.includes('hacker')]
          return sources.filter(Boolean).length >= 2
        },
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema + canvas_api_seed for article CRUD',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_schema') && usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to build the dashboard',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to test interaction',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 22 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 22,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch news sources'],
  },

  // =========================================================================
  // Case 4: API Health Monitor
  // Level 4 | web + multi-canvas + exec
  // =========================================================================
  {
    id: 'complex-api-health',
    name: 'Complex: API health monitor dashboard',
    category: 'complex',
    level: 4,
    input: 'Monitor these 3 API endpoints and show me a status dashboard:\n- https://api.example.com/health (production)\n- https://api.staging.example.com/health (staging)\n- https://api.internal.example.com/health (internal)\n\nFetch each endpoint to get their health status, then build two canvas dashboards: Canvas 1 should be a status page with green/red indicators per endpoint and uptime metrics. Canvas 2 should show response time data and a chart of the latest check results. Set up a CRUD API to track historical checks and seed it with the current results. Verify the dashboards render correctly.',
    maxScore: 100,
    toolMocks: API_HEALTH_MOCKS,
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web at least 3 times (one per endpoint)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'web') >= 3,
      },
      {
        id: 'used-canvas-create-multi',
        description: 'Used canvas_create at least 2 times (multi-canvas)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'canvas_create') >= 2,
      },
      {
        id: 'has-status-indicators',
        description: 'Has status indicators (healthy/degraded/down)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('healthy') || json.includes('degraded') || json.includes('status')
        },
      },
      {
        id: 'has-response-time',
        description: 'Has response time data (45, 230, 12 or similar)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('responsetime') || json.includes('response_time') || json.includes('latency') || json.includes('45') || json.includes('230')
        },
      },
      {
        id: 'has-metric-components',
        description: 'Has Metric components for uptime',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for historical data tracking',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to build dashboards',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch API endpoints'],
  },

  // =========================================================================
  // Case 5: Sentry Error Triage + Fix Tracker
  // Level 4 | MCP Sentry + canvas + memory
  // =========================================================================
  {
    id: 'complex-sentry-triage',
    name: 'Complex: Sentry error triage + fix tracker',
    category: 'complex',
    level: 4,
    requiredAgent: 'advanced' as const,
    input: 'Pull the top errors from Sentry using the Sentry integration and build me a triage tracker. I need a canvas with a CRUD table where each error shows its title, occurrence count, last seen date, and a status field (New/Investigating/Fixed). Seed all the Sentry errors into the CRUD API. Then test the workflow by marking one of the errors as "Fixed" using canvas_trigger_action, verify with canvas_inspect that the status changed, and log the triage action to your memory.',
    maxScore: 100,
    toolMocks: SENTRY_TRIAGE_MOCKS,
    validationCriteria: [
      {
        id: 'used-sentry-issues',
        description: 'Used SENTRY_LIST_ISSUES to fetch errors',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'SENTRY_LIST_ISSUES'),
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema-with-status',
        description: 'Used canvas_api_schema with status field',
        points: 10,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return usedTool(r, 'canvas_api_schema') && json.includes('status')
        },
      },
      {
        id: 'seeded-errors',
        description: 'Seeded errors via canvas_api_seed',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-with-fields',
        description: 'Has Table with error title, count, last seen, status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"') && toolCallsJson(r).includes('count')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to mark an error as Fixed',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify status change',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const triggerIdx = r.toolCalls.findIndex(t => t.name === 'canvas_trigger_action')
          const inspectIdx = r.toolCalls.findIndex(t => t.name === 'canvas_inspect')
          return triggerIdx >= 0 && inspectIdx > triggerIdx
        },
      },
      {
        id: 'used-memory-write',
        description: 'Used memory_write to log triage action',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch Sentry errors'],
  },

  // =========================================================================
  // Case 6: Meeting Prep Command Center
  // Level 5 | MCP Google Calendar + web + multi-canvas
  // =========================================================================
  {
    id: 'complex-meeting-prep',
    name: 'Complex: Meeting prep command center',
    category: 'complex',
    level: 5,
    input: 'Prepare me for my meetings today. Use the Google Calendar integration to get my schedule, then research each external attendee\'s company by fetching their website. Build two canvases: Canvas 1 should be today\'s schedule as a timeline with meeting titles, times, and attendees. Canvas 2 should have research cards for each company — what they do, their size, and recent news. Write prep notes to your memory. Verify both canvases render.',
    maxScore: 100,
    toolMocks: MEETING_PREP_MOCKS,
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
        id: 'used-canvas-create-multi',
        description: 'Used canvas_create at least 2 times (multi-canvas)',
        points: 10,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'canvas_create') >= 2,
      },
      {
        id: 'has-schedule-data',
        description: 'Canvas 1 has meeting schedule with times',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return (json.includes('q1 planning') || json.includes('planning')) &&
                 (json.includes('partnership') || json.includes('demo'))
        },
      },
      {
        id: 'has-company-research',
        description: 'Canvas 2 has attendee/company research',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('acme') || json.includes('partnerco') || json.includes('vcfirm')
        },
      },
      {
        id: 'used-memory-write',
        description: 'Used memory_write for prep notes',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to build layouts',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify both canvases',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch calendar events'],
  },

  // =========================================================================
  // Case 7: Stripe Revenue Dashboard + Invoice Manager
  // Level 5 | MCP Stripe + canvas + memory | Multi-turn
  // =========================================================================
  {
    id: 'complex-stripe-revenue',
    name: 'Complex: Stripe revenue dashboard + invoice manager',
    category: 'complex',
    level: 5,
    requiredAgent: 'advanced' as const,
    conversationHistory: [
      { role: 'user', content: 'I need to see my Stripe revenue and manage invoices.' },
    ],
    input: 'My MRR is about $12,500 from 180 customers. Use the Stripe integration to pull my current balance and recent payments. Build me a canvas dashboard with: revenue metrics at the top (MRR, balance, pending, customer count), a table of recent payments, and a CRUD section for invoice management where I can create new invoices (client, amount, status, due date). Seed a few sample invoices. Then test by creating a draft invoice for "Test Client" at $500 via canvas_trigger_action, verify with canvas_inspect, and log the revenue snapshot to memory.',
    maxScore: 100,
    toolMocks: STRIPE_REVENUE_MOCKS,
    validationCriteria: [
      {
        id: 'used-stripe-tools',
        description: 'Used at least one Stripe MCP tool',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'STRIPE_GET_BALANCE') || usedTool(r, 'STRIPE_LIST_PAYMENTS'),
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for invoice model',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'has-metric-components',
        description: 'Has Metric components for revenue KPIs',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-payments-table',
        description: 'Has Table for recent payments',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'used-api-seed',
        description: 'Seeded sample invoices',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to create a draft invoice',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify invoice was created',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const triggerIdx = r.toolCalls.findIndex(t => t.name === 'canvas_trigger_action')
          const inspectIdx = r.toolCalls.findIndex(t => t.name === 'canvas_inspect')
          return triggerIdx >= 0 && inspectIdx > triggerIdx
        },
      },
      {
        id: 'used-memory-write',
        description: 'Logged revenue snapshot to memory',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch Stripe data'],
  },

  // =========================================================================
  // Case 8: Multi-Repo PR Review Queue
  // Level 5 | MCP GitHub + web + canvas + send_message
  // =========================================================================
  {
    id: 'complex-pr-review-queue',
    name: 'Complex: Multi-repo PR review queue',
    category: 'complex',
    level: 5,
    requiredAgent: 'advanced' as const,
    input: 'I manage 3 repos: frontend, backend, and infra. Use the GitHub integration to pull open PRs from each repo. Build me a unified PR review queue canvas with a CRUD table showing: repo name, PR title, author, CI status, and age. Add "Approve" and "Request Changes" mutation buttons for each PR. For any PR that\'s been open more than 2 days with no review, send a Discord alert using send_message. Seed the PRs into the CRUD API. Then test the approve action on one of the PRs and verify with canvas_inspect.',
    maxScore: 100,
    toolMocks: PR_REVIEW_MOCKS,
    validationCriteria: [
      {
        id: 'used-github-issues-multi',
        description: 'Used GITHUB_LIST_ISSUES or GITHUB_LIST_PULL_REQUESTS at least 2 times (multi-repo)',
        points: 10,
        phase: 'intention',
        validate: (r) => (toolCallCount(r, 'GITHUB_LIST_ISSUES') + toolCallCount(r, 'GITHUB_LIST_PULL_REQUESTS')) >= 2,
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for PR model',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'has-pr-data-multi-repo',
        description: 'Seeded PRs from multiple repos',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          const repos = [json.includes('frontend'), json.includes('backend'), json.includes('infra')]
          return repos.filter(Boolean).length >= 2
        },
      },
      {
        id: 'has-table-with-fields',
        description: 'Canvas has Table with PR title, repo, author, CI status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"')
        },
      },
      {
        id: 'has-mutation-buttons',
        description: 'Has action/mutation buttons (approve, request changes)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('approve') || json.includes('request') || json.includes('action')
        },
      },
      {
        id: 'used-send-message',
        description: 'Used send_message for stale PR alert',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'send_message'),
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to test approve',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const triggerIdx = r.toolCalls.findIndex(t => t.name === 'canvas_trigger_action')
          const inspectIdx = r.toolCalls.findIndex(t => t.name === 'canvas_inspect')
          return triggerIdx >= 0 && inspectIdx > triggerIdx
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not fetch PRs from GitHub'],
  },
]
