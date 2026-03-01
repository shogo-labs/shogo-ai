/**
 * Memory Eval Test Cases
 *
 * Tests the agent's ability to read, write, and search its memory system.
 * Memory is stored as markdown files in the workspace/memory/ directory.
 */

import type { AgentEval } from './types'
import { usedTool } from './eval-helpers'

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
    input: 'What\'s my dog\'s name again?',
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

  // ---- Write Project Context (Odin AI agent memory) ----
  {
    id: 'memory-write-project-context',
    name: 'Memory: Remember project context',
    category: 'memory',
    level: 1,
    input: 'Remember that our project \'Phoenix\' uses React 19, deploys to AWS us-east-1, and the staging URL is https://staging.phoenix.io. We do deploys every Tuesday.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-memory-write',
        description: 'Used memory_write to persist project context',
        points: 35,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'wrote-project-name',
        description: 'Memory content includes project name (Phoenix)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('phoenix')
        },
      },
      {
        id: 'wrote-tech-stack',
        description: 'Memory content includes tech stack (React 19, AWS)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('react') && json.includes('aws')
        },
      },
      {
        id: 'wrote-deploy-schedule',
        description: 'Memory content includes deploy schedule (Tuesday)',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).toLowerCase().includes('tuesday'),
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms it remembered the context',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('remember') || text.includes('noted') || text.includes('saved') || text.includes('stored')
        },
      },
    ],
  },

  // ---- Write Communication Preference (OpenClaw notification routing) ----
  {
    id: 'memory-write-notification-routing',
    name: 'Memory: Remember notification routing rules',
    category: 'memory',
    level: 2,
    input: 'For urgent issues, notify me on Slack channel #incidents. For weekly reports, email me at ops@company.com. For everything else, just post in our general channel.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-memory-write',
        description: 'Used memory_write to persist routing rules',
        points: 35,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_write'),
      },
      {
        id: 'wrote-urgent-channel',
        description: 'Memory content includes Slack #incidents for urgent',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('incidents') && json.includes('urgent')
        },
      },
      {
        id: 'wrote-email-routing',
        description: 'Memory content includes email for weekly reports',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('ops@company.com') || (json.includes('email') && json.includes('weekly'))
        },
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms it remembered the routing rules',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('remember') || text.includes('noted') || text.includes('saved') || text.includes('stored') || text.includes('routing')
        },
      },
    ],
  },

  // ---- Use Tool But Don't Persist (n8n one-off data processing) ----
  {
    id: 'memory-ephemeral-web-fetch',
    name: 'Memory: Use web for ephemeral query, don\'t persist',
    category: 'memory',
    level: 2,
    input: 'Convert 1,500 USD to EUR at today\'s exchange rate.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-web-fetch',
        description: 'Used web to look up the exchange rate',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'web'),
      },
      {
        id: 'did-not-write-memory',
        description: 'Did NOT use memory_write for ephemeral conversion',
        points: 30,
        phase: 'intention',
        validate: (r) => !usedTool(r, 'memory_write'),
      },
      {
        id: 'response-has-amount',
        description: 'Response includes a converted EUR amount',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('eur') || text.includes('€') || text.includes('euro')
        },
      },
    ],
  },

  // ---- Search and Synthesize (Odin AI knowledge base retrieval) ----
  {
    id: 'memory-search-synthesize',
    name: 'Memory: Search and synthesize from memory',
    category: 'memory',
    level: 2,
    workspaceFiles: {
      'memory/MEMORY.md': `# Memory

## Deployment Process

We agreed on this deployment process:
1. Create a PR to staging
2. Run the e2e suite
3. Get sign-off from the on-call engineer
4. Merge to main which auto-deploys to production
`,
    },
    input: 'What deployment process did we agree on? I know we wrote it down somewhere — check your notes.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-memory-tool',
        description: 'Used memory_read or memory_search to retrieve deployment info',
        points: 35,
        phase: 'intention',
        validate: (r) => usedTool(r, 'memory_read') || usedTool(r, 'memory_search'),
      },
      {
        id: 'response-has-steps',
        description: 'Response includes deployment steps (PR, e2e, sign-off)',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('pr') || text.includes('pull request') || text.includes('staging')) &&
                 (text.includes('e2e') || text.includes('test'))
        },
      },
      {
        id: 'response-is-synthesized',
        description: 'Response is a coherent synthesis, not raw dump',
        points: 30,
        phase: 'execution',
        validate: (r) => r.responseText.length > 50 && r.responseText.length < 2000,
      },
    ],
  },
]
