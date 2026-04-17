// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent Building Eval Test Cases
 *
 * Tests the agent's ability to create specialist sub-agents that connect
 * to external services (Jira, GitHub) and produce synthesized reports.
 */

import type { AgentEval, EvalResult } from './types'
import { WEEKLY_REPORT_MOCKS } from './tool-mocks'
import { usedTool, usedToolAnywhere, responseContains, toolCallsJson } from './eval-helpers'

function subagentWasSpawned(r: EvalResult): boolean {
  return r.toolCalls.some(tc =>
    tc.name === 'task' || tc.name === 'agent_spawn',
  )
}

function dynamicAgentCreated(r: EvalResult): boolean {
  return r.toolCalls.some(tc => tc.name === 'agent_create')
}

function usedIntegrationTool(r: EvalResult, ...toolNames: string[]): boolean {
  return toolNames.some(name => usedTool(r, name))
}

function usedCanvasTools(r: EvalResult): boolean {
  return r.toolCalls.some(t => t.name.startsWith('canvas_'))
}

function allTextLower(r: EvalResult): string {
  return (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const SUBAGENT_AB_EVALS: AgentEval[] = [

  // =========================================================================
  // L5: Weekly Team Report — Jira + GitHub
  // =========================================================================
  {
    id: 'subagent-ab-weekly-report',
    name: 'Agent Build: Weekly team report from Jira + GitHub',
    category: 'subagent',
    level: 5,
    input: 'Connect to our Jira and GitHub accounts, then generate a weekly report of what the team built this week. Include completed tickets, merged PRs, who did what, and key metrics like story points completed and lines of code changed.',
    toolMocks: WEEKLY_REPORT_MOCKS,
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent delegated work to sub-agents',
        points: 5,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'installed-jira',
        description: 'Agent installed the Jira integration',
        points: 5,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install') && toolCallsJson(r).includes('jira'),
      },
      {
        id: 'installed-github',
        description: 'Agent installed the GitHub integration',
        points: 5,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install') && toolCallsJson(r).includes('github'),
      },
      {
        id: 'queried-jira',
        description: 'Agent queried Jira for issues',
        points: 5,
        phase: 'intention',
        validate: (r) => usedIntegrationTool(r, 'JIRA_GET_ISSUES', 'JIRA_GET_SPRINT'),
      },
      {
        id: 'queried-github',
        description: 'Agent queried GitHub for PRs',
        points: 5,
        phase: 'intention',
        validate: (r) => usedIntegrationTool(r, 'GITHUB_LIST_PULL_REQUESTS', 'GITHUB_GET_PULL_REQUEST'),
      },
      {
        id: 'mentions-tickets',
        description: 'Report mentions specific Jira tickets (PROJ-xxx)',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return text.includes('proj-101') || text.includes('proj-102') || text.includes('proj-103')
        },
      },
      {
        id: 'mentions-prs',
        description: 'Report mentions specific PR details (authors or titles)',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return (text.includes('alice') || text.includes('bob') || text.includes('charlie')) &&
            (text.includes('jwt') || text.includes('auth') || text.includes('password reset'))
        },
      },
      {
        id: 'includes-metrics',
        description: 'Report includes quantitative metrics (story points, lines changed, or completion count)',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return (text.includes('story point') || text.includes('points')) &&
            (text.includes('merged') || text.includes('completed') || text.includes('lines'))
        },
      },
    ],
    maxScore: 40,
  },

  // =========================================================================
  // L4: PR Summary — GitHub only
  // =========================================================================
  {
    id: 'subagent-ab-pr-summary',
    name: 'Agent Build: Summarize merged PRs this week',
    category: 'subagent',
    level: 4,
    input: 'Summarize all merged pull requests across our repos this week. For each PR, include the title, author, and a brief impact description. Group them by category (features, fixes, chores).',
    toolMocks: WEEKLY_REPORT_MOCKS,
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent delegated to a sub-agent',
        points: 4,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'installed-github',
        description: 'Agent installed GitHub integration',
        points: 4,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install') && toolCallsJson(r).includes('github'),
      },
      {
        id: 'queried-prs',
        description: 'Agent called GITHUB_LIST_PULL_REQUESTS',
        points: 4,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_LIST_PULL_REQUESTS'),
      },
      {
        id: 'mentions-pr-titles',
        description: 'Summary includes PR titles or descriptions',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return (text.includes('jwt auth') || text.includes('password reset') || text.includes('checkout'))
        },
      },
      {
        id: 'mentions-authors',
        description: 'Summary mentions PR authors',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          const authors = ['alice', 'bob', 'charlie', 'dana']
          return authors.filter(a => text.includes(a)).length >= 2
        },
      },
      {
        id: 'grouped-by-category',
        description: 'PRs are grouped by type (feat/fix/chore or similar categories)',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          const categories = ['feat', 'fix', 'chore', 'refactor', 'feature', 'bug']
          return categories.filter(c => text.includes(c)).length >= 2
        },
      },
    ],
    maxScore: 22,
  },

  // =========================================================================
  // L5: Sprint Retrospective from Jira
  // =========================================================================
  {
    id: 'subagent-ab-sprint-retro',
    name: 'Agent Build: Sprint retrospective from Jira data',
    category: 'subagent',
    level: 5,
    input: 'Prepare a sprint retrospective using our Jira data. Analyze the current sprint to determine: (1) what went well, (2) what didn\'t go well, and (3) what we can improve. Include velocity data and completion rates.',
    toolMocks: WEEKLY_REPORT_MOCKS,
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent delegated analysis to sub-agents',
        points: 4,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'installed-jira',
        description: 'Agent installed Jira integration',
        points: 4,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'tool_install') && toolCallsJson(r).includes('jira'),
      },
      {
        id: 'queried-sprint',
        description: 'Agent queried sprint data (JIRA_GET_SPRINT or JIRA_GET_ISSUES)',
        points: 4,
        phase: 'intention',
        validate: (r) => usedIntegrationTool(r, 'JIRA_GET_SPRINT', 'JIRA_GET_ISSUES'),
      },
      {
        id: 'has-went-well',
        description: 'Response has a "what went well" section',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return text.includes('went well') || text.includes('positive') || text.includes('successes') || text.includes('achievements')
        },
      },
      {
        id: 'has-improvements',
        description: 'Response has a "what to improve" section',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return text.includes('improve') || text.includes('didn\'t go well') || text.includes('challenges') || text.includes('areas for')
        },
      },
      {
        id: 'mentions-velocity',
        description: 'Response mentions velocity or story points metrics',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return (text.includes('velocity') || text.includes('story point') || text.includes('points')) &&
            (text.includes('21') || text.includes('39') || text.includes('completed'))
        },
      },
    ],
    maxScore: 24,
  },

  // =========================================================================
  // L5: Cross-tool correlation — tickets without PRs
  // =========================================================================
  {
    id: 'subagent-ab-cross-tool-correlation',
    name: 'Agent Build: Find Jira tickets without associated PRs',
    category: 'subagent',
    level: 5,
    input: 'Cross-reference our Jira tickets with GitHub PRs. Which completed or in-progress Jira tickets don\'t have an associated PR? Flag the gaps so we can follow up with the team.',
    toolMocks: WEEKLY_REPORT_MOCKS,
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent used sub-agents for data gathering',
        points: 4,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'queried-both',
        description: 'Agent queried both Jira and GitHub',
        points: 6,
        phase: 'intention',
        validate: (r) =>
          usedIntegrationTool(r, 'JIRA_GET_ISSUES') &&
          usedIntegrationTool(r, 'GITHUB_LIST_PULL_REQUESTS'),
      },
      {
        id: 'identified-gaps',
        description: 'Agent identified tickets without PRs (PROJ-107, PROJ-108, PROJ-109 have no PRs)',
        points: 8,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          // PROJ-107 (rate limiting), PROJ-108 (integration tests), PROJ-109 (docs) have no matching PRs
          const gapTickets = ['proj-107', 'proj-108', 'proj-109']
          return gapTickets.filter(t => text.includes(t)).length >= 2
        },
      },
      {
        id: 'explains-methodology',
        description: 'Agent explains how it matched tickets to PRs (by ticket ID in PR title/branch)',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return text.includes('match') || text.includes('correlat') || text.includes('reference') ||
            text.includes('associated') || text.includes('linked')
        },
      },
    ],
    maxScore: 22,
  },

  // =========================================================================
  // L5: Team metrics dashboard — canvas output
  // =========================================================================
  {
    id: 'subagent-ab-team-metrics-dashboard',
    name: 'Agent Build: Team metrics canvas from Jira + GitHub',
    category: 'subagent',
    level: 5,
    input: 'Build a team metrics dashboard on a canvas. Show: PRs merged this week, tickets completed, story points velocity, and a breakdown of who contributed what. Pull data from both our Jira and GitHub.',
    toolMocks: WEEKLY_REPORT_MOCKS,
    initialMode: 'canvas' as const,
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent used sub-agents for data gathering',
        points: 4,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'installed-both',
        description: 'Agent installed both Jira and GitHub integrations',
        points: 4,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return usedToolAnywhere(r, 'tool_install') && json.includes('jira') && json.includes('github')
        },
      },
      {
        id: 'queried-both',
        description: 'Agent queried both Jira and GitHub data sources',
        points: 4,
        phase: 'intention',
        validate: (r) =>
          usedIntegrationTool(r, 'JIRA_GET_ISSUES', 'JIRA_GET_SPRINT') &&
          usedIntegrationTool(r, 'GITHUB_LIST_PULL_REQUESTS'),
      },
      {
        id: 'used-canvas',
        description: 'Agent created a canvas to display the dashboard',
        points: 6,
        phase: 'execution',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'dashboard-has-pr-count',
        description: 'Dashboard includes PR merge count or PR data',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return (text.includes('merged') || text.includes('pull request')) && (text.includes('7') || text.includes('6'))
        },
      },
      {
        id: 'dashboard-has-velocity',
        description: 'Dashboard includes velocity or story point data',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const text = allTextLower(r)
          return text.includes('velocity') || text.includes('story point') || text.includes('21')
        },
      },
    ],
    maxScore: 24,
  },
]

export default SUBAGENT_AB_EVALS
