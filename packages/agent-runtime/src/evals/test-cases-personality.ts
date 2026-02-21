/**
 * Personality & Identity Eval Test Cases
 *
 * Tests the agent's ability to self-update its personality files
 * (SOUL.md, IDENTITY.md, AGENTS.md) via the personality_update tool.
 */

import type { AgentEval, EvalResult } from './types'

function usedTool(result: EvalResult, name: string): boolean {
  return result.toolCalls.some(t => t.name === name)
}

export const PERSONALITY_EVALS: AgentEval[] = [
  {
    id: 'personality-tone-correction',
    name: 'Personality: Adjust tone when corrected',
    category: 'personality',
    level: 2,
    input: 'From now on, always be more formal and professional in your responses. No casual language. Update your personality to reflect this.',
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
    input: 'Your name should be "Atlas" and your role is a research assistant specializing in climate science. Update your identity.',
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
]
