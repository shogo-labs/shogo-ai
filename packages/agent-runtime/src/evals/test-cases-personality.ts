/**
 * Personality & Identity Eval Test Cases
 *
 * Tests the agent's ability to self-update its personality files
 * (SOUL.md, IDENTITY.md, AGENTS.md) via the personality_update tool.
 */

import type { AgentEval } from './types'
import { usedTool } from './eval-helpers'

export const PERSONALITY_EVALS: AgentEval[] = [
  {
    id: 'personality-tone-correction',
    name: 'Personality: Adjust tone when corrected',
    category: 'personality',
    level: 2,
    input: 'From now on, I need you to be more formal and professional. No casual language — this is for a client-facing project.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-personality-update',
        description: 'Used personality_update to modify behavior',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'personality_update'),
      },
      {
        id: 'targeted-soul-md',
        description: 'Updated SOUL.md (personality/tone file)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const call = r.toolCalls.find(t => t.name === 'personality_update')
          return call?.input?.file === 'SOUL.md'
        },
      },
      {
        id: 'mentions-formal',
        description: 'Update content references formal/professional tone',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('formal') || json.includes('professional')
        },
      },
      {
        id: 'confirms-update',
        description: 'Agent confirms the personality was updated',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('update') || text.includes('adjust') || text.includes('change')
        },
      },
    ],
  },

  {
    id: 'personality-no-update-trivial',
    name: 'Personality: Don\'t update for one-off request',
    category: 'personality',
    level: 2,
    input: 'Can you explain this in simpler terms? What is quantum computing?',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-personality-update',
        description: 'Did NOT use personality_update for a one-off simplification request',
        points: 60,
        phase: 'intention',
        validate: (r) => !usedTool(r, 'personality_update'),
      },
      {
        id: 'answered-question',
        description: 'Actually explained quantum computing',
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('quantum') || text.includes('comput')
        },
      },
    ],
  },

  {
    id: 'personality-set-identity',
    name: 'Personality: Set agent name and role',
    category: 'personality',
    level: 2,
    input: 'I\'d like you to go by "Atlas" and focus on climate science research going forward.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-personality-update',
        description: 'Used personality_update tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'personality_update'),
      },
      {
        id: 'targeted-identity',
        description: 'Updated IDENTITY.md',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const call = r.toolCalls.find(t => t.name === 'personality_update')
          return call?.input?.file === 'IDENTITY.md'
        },
      },
      {
        id: 'has-name',
        description: 'Content includes the name Atlas',
        points: 25,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('Atlas'),
      },
      {
        id: 'has-role',
        description: 'Content includes research/climate role',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('research') || json.includes('climate')
        },
      },
    ],
  },

  // ---- Set Domain Expertise (Odin AI agent templates) ----
  {
    id: 'personality-domain-expertise',
    name: 'Personality: Set domain expertise',
    category: 'personality',
    level: 2,
    input: 'You\'re my DevOps guy now. I need you thinking about infra costs, security, and deployment reliability in everything we do.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-personality-update',
        description: 'Used personality_update to set domain expertise',
        points: 35,
        phase: 'intention',
        validate: (r) => usedTool(r, 'personality_update'),
      },
      {
        id: 'targeted-soul-or-agents',
        description: 'Updated SOUL.md or AGENTS.md',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const call = r.toolCalls.find(t => t.name === 'personality_update')
          const file = (call?.input?.file as string) || ''
          return file === 'SOUL.md' || file === 'AGENTS.md'
        },
      },
      {
        id: 'has-devops-role',
        description: 'Content references DevOps or infrastructure',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('devops') || json.includes('infrastructure')
        },
      },
      {
        id: 'has-security-concern',
        description: 'Content references security implications',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).toLowerCase().includes('security'),
      },
      {
        id: 'confirms-update',
        description: 'Agent confirms the personality was updated',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('update') || text.includes('devops') || text.includes('change')
        },
      },
    ],
  },

  // ---- Set Communication Boundaries (OpenClaw safety defaults) ----
  {
    id: 'personality-set-boundaries',
    name: 'Personality: Set safety boundaries',
    category: 'personality',
    level: 2,
    input: 'Hey, new rules: never run shell commands without asking me, stay away from production databases, and always suggest a dry-run before anything destructive.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-personality-update',
        description: 'Used personality_update to set boundaries',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'personality_update'),
      },
      {
        id: 'targeted-agents-md',
        description: 'Updated AGENTS.md (guidelines/rules file)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const call = r.toolCalls.find(t => t.name === 'personality_update')
          return (call?.input?.file as string) === 'AGENTS.md'
        },
      },
      {
        id: 'has-shell-boundary',
        description: 'Content mentions shell command restriction',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('shell') || json.includes('command')
        },
      },
      {
        id: 'has-production-boundary',
        description: 'Content mentions production database restriction',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('production') && json.includes('database')
        },
      },
      {
        id: 'has-dryrun-boundary',
        description: 'Content mentions dry-run before destructive ops',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('dry-run') || json.includes('dry run') || json.includes('destructive')
        },
      },
    ],
  },

  // ---- Don't Update for Style Request (negative case) ----
  {
    id: 'personality-no-update-style',
    name: 'Personality: Don\'t update for one-off style request',
    category: 'personality',
    level: 2,
    input: 'Can you rewrite this in bullet points instead? Here\'s the text: The quarterly results show growth in three areas: revenue increased 15%, customer base grew by 8,000 users, and average deal size rose to $2,400.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-personality-update',
        description: 'Did NOT use personality_update for a one-off formatting request',
        points: 55,
        phase: 'intention',
        validate: (r) => !usedTool(r, 'personality_update'),
      },
      {
        id: 'reformatted-text',
        description: 'Response contains reformatted bullet points',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText
          return text.includes('•') || text.includes('-') || text.includes('*') || text.includes('revenue')
        },
      },
      {
        id: 'preserved-data',
        description: 'Response preserves the key data points',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('15%') && (text.includes('8,000') || text.includes('8000'))
        },
      },
    ],
  },
]
