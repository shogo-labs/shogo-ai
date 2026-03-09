// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MCP Orchestration Eval Test Cases
 *
 * Complex multi-server scenarios that test the agent's ability to:
 * - Pull data from multiple MCP services in one session
 * - Synthesize and reason about the combined data
 * - Display results visually using canvas tools
 * - Handle natural multi-turn conversations
 *
 * All prompts simulate non-technical users. The agent should figure out
 * which tools to use, gather data from multiple sources, and present
 * results on a canvas.
 *
 * IMPORTANT: All conversation history messages are scripted (user→assistant
 * pairs) so that no agent turns fire during setup. All the real work
 * happens in the final input turn.
 */

import type { AgentEval, EvalResult } from './types'
import {
  INVESTOR_MEETING_PREP_MOCKS,
  PRODUCTION_INCIDENT_MOCKS,
  SUPPORT_TICKET_TRIAGE_MOCKS,
  TEAM_ONBOARDING_MOCKS,
  BUSINESS_DASHBOARD_MOCKS,
} from './tool-mocks'
import { usedTool, toolCallCount, responseContains, toolCallsJson } from './eval-helpers'

// ---------------------------------------------------------------------------
// Orchestration-specific helpers
// ---------------------------------------------------------------------------

function usedAnyTool(result: EvalResult, ...toolNames: string[]): boolean {
  return toolNames.some(name => usedTool(result, name))
}

function usedCanvasTools(result: EvalResult): boolean {
  return result.toolCalls.some(t => t.name.startsWith('canvas_'))
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const MCP_ORCHESTRATION_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Investor Meeting Prep
  // Level 5 | Calendar + DB metrics + web research → canvas prep doc
  // =========================================================================
  {
    id: 'orch-investor-meeting-prep',
    name: 'Orchestration: Investor meeting prep document',
    category: 'mcp-orchestration',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'I have an investor meeting tomorrow with David Kim from VC Firm Capital at 3:30pm. I\'m not prepared at all — can you help me get ready? Our company metrics are in postgres://admin:secret@db.acme.com:5432/analytics.' },
      { role: 'assistant', content: 'I\'ll pull together a full prep document for you. Let me check your calendar for the meeting details, research David Kim and VC Firm Capital, and pull your latest metrics from the database.' },
    ],
    input: 'Pull the meeting details from my calendar, look up David Kim and his fund online, and grab our latest metrics from the database. Then put it all together in a visual prep document with talking points.',
    maxScore: 100,
    toolMocks: INVESTOR_MEETING_PREP_MOCKS,
    validationCriteria: [
      {
        id: 'fetched-calendar',
        description: 'Checked the calendar for meeting details',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GOOGLECALENDAR_FIND_EVENT'),
      },
      {
        id: 'researched-investor',
        description: 'Researched David Kim / VC Firm Capital online',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'web'),
      },
      {
        id: 'queried-metrics',
        description: 'Queried the database for company metrics',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'mcp_postgres_query'),
      },
      {
        id: 'used-canvas',
        description: 'Created a canvas to display the prep document',
        points: 15,
        phase: 'execution',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'mentions-david-kim',
        description: 'Response or canvas mentions David Kim',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'david') || toolCallsJson(r).includes('david'),
      },
      {
        id: 'mentions-metrics',
        description: 'Response includes key business metrics',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('arr') || all.includes('revenue') || all.includes('2.4') || all.includes('2,400') || all.includes('1,247') || all.includes('1247')
        },
      },
      {
        id: 'mentions-vc-interests',
        description: 'Response mentions what the investor cares about',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('developer') || all.includes('infrastructure') || all.includes('ai') || all.includes('datadog') || all.includes('portfolio')
        },
      },
      {
        id: 'has-talking-points',
        description: 'Response includes talking points or recommendations',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('talking point') || text.includes('highlight') || text.includes('recommend') || text.includes('emphasize') || text.includes('mention') || text.includes('tip') || text.includes('suggest')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not create canvas'],
  },

  // =========================================================================
  // Case 3: Production Incident Investigation
  // Level 5 | Sentry + GitHub deploys + Datadog + Slack → canvas timeline
  // =========================================================================
  {
    id: 'orch-production-incident',
    name: 'Orchestration: Production incident investigation',
    category: 'mcp-orchestration',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'Something is broken in production! Users are reporting they can\'t log in and the app is super slow. Started about 30 minutes ago.' },
      { role: 'assistant', content: 'I\'m on it — let me investigate right away. I\'ll check Sentry for errors, look at recent deploys on GitHub, and pull infrastructure metrics from Datadog to correlate everything.' },
    ],
    input: 'Show me a visual timeline of what happened and what you think caused it. Also post your findings to #incidents on Slack so the team knows.',
    maxScore: 100,
    toolMocks: PRODUCTION_INCIDENT_MOCKS,
    validationCriteria: [
      {
        id: 'checked-errors',
        description: 'Checked Sentry for error reports',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'SENTRY_LIST_ISSUES'),
      },
      {
        id: 'checked-deploys',
        description: 'Checked GitHub for recent deploys',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_LIST_RECENT_DEPLOYS'),
      },
      {
        id: 'checked-metrics',
        description: 'Checked Datadog for infrastructure metrics',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'DATADOG_QUERY_METRICS'),
      },
      {
        id: 'posted-to-slack',
        description: 'Posted findings to #incidents on Slack',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL'),
      },
      {
        id: 'used-canvas',
        description: 'Created a canvas to display the incident timeline',
        points: 15,
        phase: 'execution',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'identified-root-cause',
        description: 'Identified the auth middleware deploy as likely cause',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return (all.includes('auth') || all.includes('session') || all.includes('middleware')) &&
                 (all.includes('deploy') || all.includes('#187') || all.includes('bob') || all.includes('refactor'))
        },
      },
      {
        id: 'correlated-timing',
        description: 'Correlated the error spike with the deploy timing',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('14:') || all.includes('spike') || all.includes('correlat') || all.includes('around the same time') || all.includes('shortly after')
        },
      },
      {
        id: 'mentions-impact',
        description: 'Mentions the impact (error rate, latency, affected users)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('15%') || all.includes('error rate') || all.includes('672') || all.includes('latency') || all.includes('3.1') || all.includes('3100')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not create canvas'],
  },

  // =========================================================================
  // Case 4: Support Ticket Triage → Engineering Tasks
  // Level 5 | Zendesk + Linear + Slack → canvas summary board
  // =========================================================================
  {
    id: 'orch-support-ticket-triage',
    name: 'Orchestration: Support ticket triage and task creation',
    category: 'mcp-orchestration',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'I want to look at our support tickets from the last couple weeks and figure out what patterns are hurting our users the most. Then create engineering tasks for the top issues.' },
      { role: 'assistant', content: 'I\'ll pull your recent Zendesk tickets, analyze them for patterns, create engineering tasks in Linear for the key issues, and put together a visual summary. Should I also notify the team?' },
      { role: 'user', content: 'Yes, post a summary to #engineering when you\'re done.' },
      { role: 'assistant', content: 'Got it — I\'ll post to #engineering after everything is set up. Let me get started.' },
    ],
    input: 'Go ahead — pull the tickets from Zendesk, figure out the patterns, create engineering tasks in Linear for the top issues, post a summary to #engineering on Slack, and show me a visual breakdown of everything.',
    maxScore: 100,
    toolMocks: SUPPORT_TICKET_TRIAGE_MOCKS,
    validationCriteria: [
      {
        id: 'pulled-tickets',
        description: 'Pulled support tickets from Zendesk',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'ZENDESK_LIST_TICKETS'),
      },
      {
        id: 'created-linear-issues',
        description: 'Created engineering tasks in Linear',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'LINEAR_CREATE_ISSUE'),
      },
      {
        id: 'created-multiple-issues',
        description: 'Created multiple Linear issues for different categories',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'LINEAR_CREATE_ISSUE') >= 2,
      },
      {
        id: 'posted-to-slack',
        description: 'Posted summary to #engineering on Slack',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL'),
      },
      {
        id: 'used-canvas',
        description: 'Created a canvas to display the triage summary',
        points: 15,
        phase: 'execution',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'identified-login-pattern',
        description: 'Identified login/auth as a major issue category',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('login') || all.includes('auth') || all.includes('sso')
        },
      },
      {
        id: 'identified-dashboard-pattern',
        description: 'Identified dashboard performance as an issue category',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('dashboard') || all.includes('performance') || all.includes('slow')
        },
      },
      {
        id: 'prioritized-urgent',
        description: 'Recognized the SSO or billing issues as urgent',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('urgent') || all.includes('sso') || all.includes('duplicate') || all.includes('charged twice')
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
    antiPatterns: ['No tool calls at all', 'Did not create canvas'],
  },

  // =========================================================================
  // Case 5: New Team Member Onboarding
  // Level 5 | GitHub + Slack + Linear → canvas onboarding checklist
  // =========================================================================
  {
    id: 'orch-team-onboarding',
    name: 'Orchestration: New team member onboarding setup',
    category: 'mcp-orchestration',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'We have a new engineer starting on Monday. Can you help get everything set up for her?' },
      { role: 'assistant', content: 'Happy to help with onboarding! I can set her up on GitHub, Slack, and create onboarding tasks in Linear. What\'s her name, email, and which team is she joining?' },
      { role: 'user', content: 'Sarah Chen, GitHub username sarahchen, email sarah@acme.com. She\'s joining the Platform team. Our GitHub org is acme-corp.' },
      { role: 'assistant', content: 'Got it — Sarah Chen (sarahchen) joining Platform at acme-corp. I\'ll set up GitHub, Slack, and Linear for her.' },
    ],
    input: 'Go ahead! Add her to our GitHub org, invite her to Slack (add her to #platform, #engineering, #general), create onboarding tasks in Linear like setting up dev environment and reviewing the docs, and send a welcome message to #platform. Show me a visual checklist of everything you did.',
    maxScore: 100,
    toolMocks: TEAM_ONBOARDING_MOCKS,
    validationCriteria: [
      {
        id: 'added-to-github',
        description: 'Added Sarah to GitHub org',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_ADD_MEMBER_TO_ORG'),
      },
      {
        id: 'invited-to-slack',
        description: 'Invited Sarah to Slack',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'SLACK_INVITE_USER_TO_WORKSPACE'),
      },
      {
        id: 'created-onboarding-tasks',
        description: 'Created onboarding tasks in Linear',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'LINEAR_CREATE_ISSUE'),
      },
      {
        id: 'sent-welcome-message',
        description: 'Sent welcome message to Slack',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL'),
      },
      {
        id: 'welcome-mentions-sarah',
        description: 'Welcome message mentions Sarah',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const slackCalls = r.toolCalls.filter(t => t.name === 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL')
          return slackCalls.some(t => JSON.stringify(t.input).toLowerCase().includes('sarah'))
        },
      },
      {
        id: 'multiple-onboarding-tasks',
        description: 'Created multiple onboarding tasks',
        points: 5,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'LINEAR_CREATE_ISSUE') >= 2,
      },
      {
        id: 'used-canvas',
        description: 'Created a canvas showing the onboarding checklist',
        points: 15,
        phase: 'execution',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'github-includes-sarah',
        description: 'GitHub add included Sarah\'s details',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const ghCall = r.toolCalls.find(t => t.name === 'GITHUB_ADD_MEMBER_TO_ORG')
          if (!ghCall) return false
          const json = JSON.stringify(ghCall.input).toLowerCase()
          return json.includes('sarah') || json.includes('acme')
        },
      },
      {
        id: 'response-summarizes',
        description: 'Response summarizes all onboarding steps completed',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const hasGithub = text.includes('github') || text.includes('repo')
          const hasSlack = text.includes('slack') || text.includes('channel')
          const hasLinear = text.includes('linear') || text.includes('task') || text.includes('onboarding')
          return hasGithub && hasSlack && hasLinear
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
    antiPatterns: ['No tool calls at all', 'Did not create canvas'],
  },

  // =========================================================================
  // Case 6: Weekly Business Dashboard
  // Level 5 | Stripe + Postgres + GitHub → canvas dashboard + cron
  // =========================================================================
  {
    id: 'orch-business-dashboard',
    name: 'Orchestration: Weekly business metrics dashboard',
    category: 'mcp-orchestration',
    level: 5,
    conversationHistory: [
      { role: 'user', content: 'I want a dashboard that shows me how the business is doing each week — revenue, signups, active users, and how fast the engineering team is shipping.' },
      { role: 'assistant', content: 'Great idea! I can pull revenue from Stripe, user metrics from your database, and engineering velocity from GitHub. Where should I connect for the database and GitHub?' },
      { role: 'user', content: 'Database is postgres://admin:secret@db.acme.com:5432/analytics and our GitHub org is acme-corp. Also set it up to auto-refresh every Monday morning.' },
      { role: 'assistant', content: 'Perfect — I\'ll pull from all three sources, build a visual dashboard, and schedule a weekly Monday refresh.' },
    ],
    input: 'Pull the latest numbers from Stripe, query the database for signups and active users, check GitHub for engineering stats, then build me a beautiful visual dashboard. And set up the Monday morning refresh.',
    maxScore: 100,
    toolMocks: BUSINESS_DASHBOARD_MOCKS,
    validationCriteria: [
      {
        id: 'fetched-stripe',
        description: 'Pulled revenue data from Stripe',
        points: 10,
        phase: 'intention',
        validate: (r) => usedAnyTool(r, 'STRIPE_GET_BALANCE', 'STRIPE_LIST_PAYMENTS'),
      },
      {
        id: 'queried-database',
        description: 'Queried the database for user metrics',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'mcp_postgres_query'),
      },
      {
        id: 'fetched-github',
        description: 'Pulled engineering velocity from GitHub',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_LIST_PULL_REQUESTS'),
      },
      {
        id: 'used-canvas',
        description: 'Created a canvas dashboard',
        points: 15,
        phase: 'execution',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'dashboard-has-revenue',
        description: 'Dashboard includes revenue numbers',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('revenue') || all.includes('12,500') || all.includes('12500') || all.includes('stripe') || all.includes('arr') || all.includes('mrr') || all.includes('balance')
        },
      },
      {
        id: 'dashboard-has-users',
        description: 'Dashboard includes user/signup metrics',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('signup') || all.includes('active user') || all.includes('wau') || all.includes('892') || all.includes('156')
        },
      },
      {
        id: 'dashboard-has-engineering',
        description: 'Dashboard includes engineering velocity',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('pr') || all.includes('merged') || all.includes('cycle time') || all.includes('velocity') || all.includes('engineering')
        },
      },
      {
        id: 'set-up-cron',
        description: 'Set up a weekly refresh schedule',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'cron'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not create canvas'],
  },
]
