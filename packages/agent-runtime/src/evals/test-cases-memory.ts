/**
 * Memory Eval Test Cases
 *
 * Tests the agent's ability to read, write, and search its memory system.
 * Memory is stored as markdown files in the workspace/memory/ directory.
 */

import type { AgentEval, EvalResult } from './types'

function usedTool(result: EvalResult, name: string): boolean {
  return result.toolCalls.some(t => t.name === name)
}

export const MEMORY_EVALS: AgentEval[] = [
  {
    id: 'memory-write-preference',
    name: 'Memory: Remember user preference',
    category: 'memory',
    level: 1,
    input: 'Remember that my favorite color is blue and I prefer dark mode interfaces.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-memory-write',
        description: 'Used memory_write to store the preference',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'wrote-color',
        description: 'Memory content includes color preference',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('blue') || json.includes('color')
        },
      },
      {
        id: 'wrote-dark-mode',
        description: 'Memory content includes dark mode preference',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('dark mode') || json.includes('dark')
        },
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms it remembered',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('remember') || text.includes('noted') || text.includes('saved') || text.includes('stored')
        },
      },
    ],
  },

  {
    id: 'memory-multi-turn-recall',
    name: 'Memory: Recall from previous conversation',
    category: 'memory',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'Please remember that my dog\'s name is Milo and he\'s a golden retriever.' },
    ],
    input: 'What\'s my dog\'s name? Check your memory if you don\'t remember.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-memory-tool',
        description: 'Used memory_read or memory_search to look up the info',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_read') || usedTool(r, 'memory_search'),
      },
      {
        id: 'response-has-name',
        description: 'Response mentions the dog\'s name (Milo)',
        points: 40,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('milo'),
      },
      {
        id: 'response-has-breed',
        description: 'Response mentions the breed (golden retriever)',
        points: 30,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('golden'),
      },
    ],
  },

  {
    id: 'memory-no-write-trivial',
    name: 'Memory: Don\'t write trivial requests',
    category: 'memory',
    level: 2,
    input: 'What time is it in Tokyo right now?',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'did-not-write-memory',
        description: 'Did NOT use memory_write for a one-off question',
        points: 50,
        phase: 'intention',
        validate: (r) => !usedTool(r, 'memory_write'),
      },
      {
        id: 'answered-question',
        description: 'Actually answered the time question',
        points: 50,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('time') || text.includes('tokyo') || text.includes(':') || text.includes('am') || text.includes('pm')
        },
      },
    ],
  },
]
