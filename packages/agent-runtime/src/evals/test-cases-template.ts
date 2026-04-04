// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Template Eval Track
 *
 * Tests that template-seeded agents behave correctly:
 * - Onboarding: agent describes template purpose, lists skills, suggests tools
 * - Skill matching: trigger messages activate the correct skill
 * - Template-specific behavior: agent follows AGENTS.md instructions
 */

import type { AgentEval } from './types'
import { getAgentTemplateById } from '../agent-templates'
import { usedTool } from './eval-helpers'

function getTemplateFiles(templateId: string): Record<string, string> {
  const template = getAgentTemplateById(templateId)
  if (!template) throw new Error(`Template ${templateId} not found`)
  return template.files
}

export const TEMPLATE_EVALS: AgentEval[] = [
  // ── Onboarding: Research Assistant ──────────────────────────────────
  {
    id: 'template-onboarding-research',
    name: 'Template Onboarding: Research Assistant describes setup',
    category: 'template',
    level: 2,
    input: 'The "Research Assistant" template has been installed. Can you describe what\'s been set up and walk me through how to customize it or connect my own tools?',
    workspaceFiles: {
      ...getTemplateFiles('research-analyst'),
      '.shogo/skills/research-deep/SKILL.md': '---\nname: research-deep\nversion: 2.0.0\ndescription: Deep research on a topic\ntrigger: "research|look up|find out about"\ntools: [web, write_file, edit_file]\n---\n# Deep Research\nPerform multi-source research and present findings.',
      '.shogo/skills/topic-tracker/SKILL.md': '---\nname: topic-tracker\nversion: 2.0.0\ndescription: Track topics over time\ntrigger: "daily digest|morning briefing"\ntools: [web, memory_read, write_file, edit_file]\n---\n# Topic Tracker\nCompile daily digest of tracked topics.',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'mentions-purpose',
        description: 'Agent describes itself as a research assistant',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('research') && (text.includes('assistant') || text.includes('analyst'))
        },
      },
      {
        id: 'lists-skills',
        description: 'Agent mentions installed skills by name',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('research') && (text.includes('topic') || text.includes('tracker') || text.includes('digest'))
        },
      },
      {
        id: 'mentions-canvas',
        description: 'Agent mentions canvas dashboards as a capability',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('canvas') || text.includes('dashboard')
        },
      },
      {
        id: 'suggests-customization',
        description: 'Agent suggests customization options (tools, topics, channels)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('customize') || text.includes('connect') || text.includes('configure') || text.includes('set up')
        },
      },
      {
        id: 'mentions-heartbeat',
        description: 'Agent mentions the heartbeat/monitoring feature',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('heartbeat') || text.includes('automatic') || text.includes('check') || text.includes('monitor')
        },
      },
    ],
  },

  // ── Onboarding: GitHub Ops ──────────────────────────────────────────
  {
    id: 'template-onboarding-github',
    name: 'Template Onboarding: GitHub Ops suggests connecting GitHub',
    category: 'template',
    level: 2,
    input: 'The "GitHub Ops" template has been installed. Can you describe what\'s been set up and walk me through how to customize it or connect my own tools?',
    workspaceFiles: {
      ...getTemplateFiles('devops-hub'),
      '.shogo/skills/github-ops/SKILL.md': '---\nname: github-ops\nversion: 2.0.0\ndescription: Monitor GitHub repos via Composio\ntrigger: "check github|repo status|ci status"\ntools: [tool_search, tool_install, write_file, edit_file, send_message]\n---\n# GitHub Ops\nCheck GitHub repos and build a triage dashboard.',
      '.shogo/skills/pr-review/SKILL.md': '---\nname: pr-review\nversion: 2.0.0\ndescription: Review pull requests\ntrigger: "review pr|code review"\ntools: [tool_search, tool_install, write_file, edit_file]\n---\n# PR Review\nFetch diff, analyze, post feedback.',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'mentions-github',
        description: 'Agent identifies itself as a GitHub operations agent',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('github')
        },
      },
      {
        id: 'suggests-connect-github',
        description: 'Agent suggests connecting GitHub integration',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('connect') && text.includes('github')
        },
      },
      {
        id: 'mentions-skills',
        description: 'Agent mentions installed skills (github-ops, pr-review)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('pr') || text.includes('pull request') || text.includes('review')) && (text.includes('monitor') || text.includes('triage') || text.includes('ci'))
        },
      },
      {
        id: 'mentions-heartbeat',
        description: 'Agent mentions CI monitoring or heartbeat',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('ci') || text.includes('heartbeat') || text.includes('15 min') || text.includes('monitor')
        },
      },
      {
        id: 'suggests-repos',
        description: 'Agent asks which repos to watch',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('repo') && (text.includes('which') || text.includes('watch') || text.includes('configure'))
        },
      },
    ],
  },

  // ── Skill Matching: Research Deep triggers on research request ──────
  {
    id: 'template-skill-research-trigger',
    name: 'Template Skill: Research request triggers web search and canvas',
    category: 'template',
    level: 3,
    input: 'Research the latest developments in AI agent frameworks — compare LangGraph, CrewAI, and AutoGen.',
    workspaceFiles: {
      ...getTemplateFiles('research-analyst'),
      '.shogo/skills/research-deep/SKILL.md': '---\nname: research-deep\nversion: 2.0.0\ndescription: Deep research on a topic\ntrigger: "research|look up|find out about|deep dive|analyze|compare"\ntools: [web, write_file, edit_file]\n---\n# Deep Research\nWhen triggered:\n1. Search multiple sources\n2. Synthesize findings\n3. Build dashboard\n4. Save to memory',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-web-search',
        description: 'Agent used web tool to search for information',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'web'),
      },
      {
        id: 'used-canvas',
        description: 'Agent created a canvas to present findings',
        points: 30,
        phase: 'execution',
        validate: (r) => usedTool(r, 'write_file'),
      },
      {
        id: 'mentions-frameworks',
        description: 'Response mentions the requested AI frameworks',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('langgraph') || text.includes('crewai') || text.includes('autogen')
        },
      },
      {
        id: 'uses-memory',
        description: 'Agent saved findings to memory via write_file',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'write_file'),
      },
    ],
  },

  // ── Skill Matching: GitHub Ops triggers on "check github" ──────────
  {
    id: 'template-skill-github-trigger',
    name: 'Template Skill: "check github" triggers GitHub ops skill',
    category: 'template',
    level: 3,
    input: 'Check the status of my repos — are there any open PRs or CI failures?',
    workspaceFiles: {
      ...getTemplateFiles('devops-hub'),
      '.shogo/skills/github-ops/SKILL.md': '---\nname: github-ops\nversion: 2.0.0\ndescription: Monitor GitHub repos via Composio\ntrigger: "check github|repo status|ci status|pr review|open prs|pull requests"\ntools: [tool_search, tool_install, write_file, edit_file, send_message]\n---\n# GitHub Ops\n1. Search for GitHub integration (tool_search). If not installed: tool_install({ name: "github" })\n2. Fetch open PRs and issues\n3. Build or update dashboard\n4. Alert on stale PRs',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'checked-tools',
        description: 'Agent searched for integrations (tool_search)',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'tried-install-github',
        description: 'Agent tried to install or connect GitHub integration',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          if (usedTool(r, 'tool_install')) {
            const call = r.toolCalls.find(t => t.name === 'tool_install')
            return JSON.stringify(call?.input).toLowerCase().includes('github')
          }
          return false
        },
      },
      {
        id: 'mentions-prs-or-ci',
        description: 'Response discusses PRs, issues, or CI status',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('pr') || text.includes('pull request') || text.includes('ci') || text.includes('issue')
        },
      },
      {
        id: 'attempts-canvas',
        description: 'Agent attempts to build a dashboard',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'write_file'),
      },
    ],
  },

  // ── Template Behavior: Incident Commander follows priority rules ────
  {
    id: 'template-behavior-incident',
    name: 'Template Behavior: Incident Commander investigates outage',
    category: 'template',
    level: 3,
    input: 'Our API is returning 500 errors and users are complaining. Can you investigate?',
    workspaceFiles: {
      ...getTemplateFiles('operations-monitor'),
      '.shogo/skills/health-check/SKILL.md': '---\nname: health-check\nversion: 2.0.0\ndescription: Check service health endpoints\ntrigger: "health check|service status|is it up"\ntools: [web, write_file, edit_file, send_message]\n---\n# Health Check\n1. Check health endpoints\n2. Build status page\n3. Alert on failures',
      '.shogo/skills/incident-triage/SKILL.md': '---\nname: incident-triage\nversion: 2.0.0\ndescription: Investigate production incidents\ntrigger: "incident|something broke|production issue|outage|error spike"\ntools: [tool_search, tool_install, web, write_file, edit_file, send_message]\n---\n# Incident Triage\n1. Check Sentry, GitHub, Datadog\n2. Correlate timing\n3. Build incident timeline',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'investigates',
        description: 'Agent actively investigates (uses web or tool_search)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'web') || usedTool(r, 'tool_search'),
      },
      {
        id: 'uses-canvas',
        description: 'Agent builds an incident status page',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'write_file'),
      },
      {
        id: 'mentions-investigation',
        description: 'Response includes investigation language (error, deploy, root cause)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('error') || text.includes('500')) &&
            (text.includes('investigate') || text.includes('check') || text.includes('look'))
        },
      },
      {
        id: 'suggests-tools',
        description: 'Agent suggests connecting monitoring tools (Sentry, Datadog)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('sentry') || text.includes('datadog') || text.includes('monitoring')
        },
      },
    ],
  },

  // ── Template Behavior: Personal Assistant habit tracking ────────────
  {
    id: 'template-behavior-habits',
    name: 'Template Behavior: Personal Assistant builds habit board',
    category: 'template',
    level: 3,
    input: 'I want to track these daily habits: meditate 10 minutes, read for 30 minutes, and exercise.',
    workspaceFiles: {
      ...getTemplateFiles('personal-assistant'),
      '.shogo/skills/habit-track/SKILL.md': '---\nname: habit-track\nversion: 2.0.0\ndescription: Track daily habits on a kanban board with streaks\ntrigger: "habit|track habit|log habit|check habits|my habits|streak|add habit"\ntools: [write_file, edit_file, memory_read]\n---\n# Habit Tracker\n1. Define habit CRUD schema\n2. Build kanban board\n3. Track streaks',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'creates-api-schema',
        description: 'Agent sets up a CRUD schema for habits',
        points: 30,
        phase: 'execution',
        validate: (r) => usedTool(r, 'write_file'),
      },
      {
        id: 'creates-canvas',
        description: 'Agent builds the habit board',
        points: 25,
        phase: 'execution',
        validate: (r) => usedTool(r, 'write_file'),
      },
      {
        id: 'seeds-habits',
        description: 'Agent seeds the 3 requested habits',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('meditat') && json.includes('read') && json.includes('exercis')
        },
      },
      {
        id: 'mentions-streaks',
        description: 'Response mentions streak tracking',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('streak') || text.includes('track')
        },
      },
    ],
  },

  // ── Onboarding: Support Desk suggests ticketing tools ──────────────
  {
    id: 'template-onboarding-support',
    name: 'Template Onboarding: Support Desk suggests connecting ticketing tool',
    category: 'template',
    level: 2,
    input: 'The "Support Desk" template has been installed. Can you describe what\'s been set up and walk me through how to customize it or connect my own tools?',
    workspaceFiles: {
      ...getTemplateFiles('support-ops'),
      '.shogo/skills/ticket-triage/SKILL.md': '---\nname: ticket-triage\nversion: 2.0.0\ndescription: Triage support tickets\ntrigger: "triage tickets|support tickets"\ntools: [tool_search, tool_install, write_file, edit_file]\n---\n# Ticket Triage\nPull and triage support tickets.',
      '.shogo/skills/escalation-alert/SKILL.md': '---\nname: escalation-alert\nversion: 2.0.0\ndescription: Escalate urgent issues\ntrigger: "escalate|urgent|p0"\ntools: [send_message, write_file, edit_file]\n---\n# Escalation Alert\nEscalate critical issues to team.',
    },
    maxScore: 100,
    validationCriteria: [
      {
        id: 'mentions-support',
        description: 'Agent identifies as support triage agent',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('support') && (text.includes('triage') || text.includes('ticket'))
        },
      },
      {
        id: 'suggests-ticketing-tool',
        description: 'Agent suggests connecting Zendesk, Linear, or other ticketing tool',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('zendesk') || text.includes('linear') || text.includes('ticketing')
        },
      },
      {
        id: 'mentions-escalation',
        description: 'Agent mentions escalation capabilities',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('escalat') || text.includes('alert') || text.includes('urgent')
        },
      },
      {
        id: 'mentions-dashboard',
        description: 'Agent mentions building a support dashboard',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('dashboard') || text.includes('canvas')
        },
      },
      {
        id: 'mentions-kpis',
        description: 'Agent mentions support KPIs (tickets, response time, CSAT)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('ticket') || text.includes('response time') || text.includes('csat') || text.includes('metric')
        },
      },
    ],
  },
]
