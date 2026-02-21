/**
 * Multi-turn Conversation Eval Test Cases
 *
 * Tests the agent's ability to handle multi-step conversations,
 * maintain context, and plan tool sequences efficiently.
 */

import type { AgentEval, EvalResult } from './types'

function usedTool(result: EvalResult, name: string): boolean {
  return result.toolCalls.some(t => t.name === name)
}

export const MULTITURN_EVALS: AgentEval[] = [
  {
    id: 'multiturn-canvas-then-modify',
    name: 'Multi-turn: Build canvas then modify it',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Create a simple counter canvas that shows a count starting at 0.',
      },
    ],
    input: 'Now update the counter to show 42 instead of 0.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data to update the counter value',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data'),
      },
      {
        id: 'updated-to-42',
        description: 'Set the value to 42',
        points: 30,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('42'),
      },
      {
        id: 'did-not-recreate',
        description: 'Did NOT recreate the surface from scratch (efficient)',
        points: 30,
        phase: 'execution',
        validate: (r) => !usedTool(r, 'canvas_create'),
      },
    ],
    antiPatterns: ['Recreated surface unnecessarily'],
  },

  {
    id: 'multiturn-memory-then-use',
    name: 'Multi-turn: Store preference then use it',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Remember that I always want weather in Celsius, not Fahrenheit.',
      },
    ],
    input: 'What\'s a nice way to display the current temperature of 25°C on a canvas?',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-tools',
        description: 'Built a canvas to display the temperature',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create') || usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-celsius',
        description: 'Used Celsius (not Fahrenheit) as requested',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          const text = r.responseText.toLowerCase()
          const usesCelsius = json.includes('celsius') || json.includes('°c') || json.includes('25')
          const noFahrenheit = !json.includes('fahrenheit') && !text.includes('fahrenheit')
          return usesCelsius && noFahrenheit
        },
      },
      {
        id: 'responded-helpfully',
        description: 'Gave a helpful response about the canvas',
        points: 35,
        phase: 'execution',
        validate: (r) => r.responseText.length > 20,
      },
    ],
  },

  {
    id: 'multiturn-progressive-build',
    name: 'Multi-turn: Progressively build a dashboard',
    category: 'multiturn',
    level: 4,
    conversationHistory: [
      {
        role: 'user',
        content: 'Start building me a sales dashboard canvas. Begin with just a title "Q4 Sales Dashboard".',
      },
      {
        role: 'user',
        content: 'Now add three Metric components: Revenue ($125K), Orders (847), Avg Order ($148).',
      },
    ],
    input: 'Finally, add a Chart component showing monthly trends below the metrics.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to add the chart',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-chart',
        description: 'Added a Chart component',
        points: 30,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Chart"'),
      },
      {
        id: 'efficient-update',
        description: 'Did not rebuild the entire dashboard from scratch',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const createCalls = r.toolCalls.filter(t => t.name === 'canvas_create')
          return createCalls.length === 0
        },
      },
      {
        id: 'reasonable-tools',
        description: 'Used <= 6 tool calls for this incremental update',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 6,
      },
    ],
  },
]
