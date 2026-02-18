/**
 * Tests for the Agent Evaluation Framework
 *
 * These tests verify the evaluation infrastructure itself works correctly.
 */

import { describe, test, expect } from 'bun:test'
import {
  runEval,
  runEvalSuite,
  formatEvalReport,
  type MockAgentResponse,
} from '../runner'
import {
  evaluateToolCorrectness,
  evaluateTemplateSelection,
  calculateParamSimilarity,
  extractSelectedTemplate,
  didAskClarification,
  ranForbiddenRuntimeCommands,
  extractForbiddenCommands,
  VALID_TEMPLATES,
} from '../validators'
import {
  EVAL_TODO_DIRECT,
  EVAL_EXPENSE_DIRECT,
  EVAL_AMBIGUOUS_TEAM,
  EVAL_PARAMS_WITH_NAME,
  ALL_EVALS,
  EVAL_RESTART_VITE,
  EVAL_RUN_BUILD,
  EVAL_START_DEV_SERVER,
  EVAL_CHANGES_NOT_SHOWING,
  EVAL_PREVIEW_BROKEN,
  RUNTIME_SAFETY_EVALS,
} from '../test-cases'
import type { ToolCall, ExpectedToolCall } from '../types'

describe('Validators', () => {
  describe('evaluateToolCorrectness', () => {
    test('returns perfect score when all required tools called with correct params', () => {
      const expected: ExpectedToolCall[] = [
        { name: 'template.copy', params: { template: 'todo-app' }, required: true },
      ]
      const actual: ToolCall[] = [
        { name: 'template.copy', params: { template: 'todo-app', name: 'my-app' } },
      ]

      const result = evaluateToolCorrectness(expected, actual)

      expect(result.toolSelectionAccuracy).toBe(1.0)
      expect(result.parameterAccuracy).toBe(1.0)
      expect(result.missingTools).toHaveLength(0)
      expect(result.overallScore).toBeGreaterThan(0.9)
    })

    test('returns low score when required tool missing', () => {
      const expected: ExpectedToolCall[] = [
        { name: 'template.copy', required: true },
      ]
      const actual: ToolCall[] = [
        { name: 'template.list', params: {} },
      ]

      const result = evaluateToolCorrectness(expected, actual)

      expect(result.toolSelectionAccuracy).toBe(0)
      expect(result.missingTools).toContain('template.copy')
    })

    test('penalizes unexpected tool calls', () => {
      const expected: ExpectedToolCall[] = [
        { name: 'template.copy', required: true },
      ]
      const actual: ToolCall[] = [
        { name: 'template.copy', params: {} },
        { name: 'bash', params: { command: 'bun install' } },
        { name: 'bash', params: { command: 'prisma generate' } },
      ]

      const result = evaluateToolCorrectness(expected, actual)

      expect(result.unexpectedTools).toHaveLength(2)
      expect(result.overallScore).toBeLessThan(0.9)
    })
  })

  describe('evaluateTemplateSelection', () => {
    test('returns score 1.0 for exact match', () => {
      const result = evaluateTemplateSelection('todo-app', 'todo-app')
      expect(result.matched).toBe(true)
      expect(result.score).toBe(1.0)
    })

    test('returns score 0.5 for related template', () => {
      const result = evaluateTemplateSelection('todo-app', 'kanban')
      expect(result.matched).toBe(false)
      expect(result.score).toBe(0.5)
    })

    test('returns score 0 for unrelated template', () => {
      const result = evaluateTemplateSelection('todo-app', 'ai-chat')
      expect(result.matched).toBe(false)
      expect(result.score).toBe(0)
    })

    test('handles null actual', () => {
      const result = evaluateTemplateSelection('todo-app', null)
      expect(result.matched).toBe(false)
      expect(result.score).toBe(0)
    })
  })

  describe('calculateParamSimilarity', () => {
    test('returns 1.0 for exact match', () => {
      const expected = { template: 'todo-app', name: 'my-app' }
      const actual = { template: 'todo-app', name: 'my-app' }
      expect(calculateParamSimilarity(expected, actual)).toBe(1.0)
    })

    test('returns partial score for partial match', () => {
      const expected = { template: 'todo-app', name: 'my-app' }
      const actual = { template: 'todo-app', name: 'different' }
      const score = calculateParamSimilarity(expected, actual)
      expect(score).toBe(0.5) // 1 of 2 matches
    })

    test('returns 1.0 for empty expected', () => {
      expect(calculateParamSimilarity({}, { any: 'thing' })).toBe(1.0)
    })
  })

  describe('extractSelectedTemplate', () => {
    test('extracts template from copy call', () => {
      const toolCalls: ToolCall[] = [
        { name: 'template.list', params: {} },
        { name: 'template.copy', params: { template: 'expense-tracker' } },
      ]
      expect(extractSelectedTemplate(toolCalls)).toBe('expense-tracker')
    })

    test('returns null when no copy call', () => {
      const toolCalls: ToolCall[] = [
        { name: 'template.list', params: {} },
      ]
      expect(extractSelectedTemplate(toolCalls)).toBeNull()
    })
  })

  describe('didAskClarification', () => {
    test('detects clarifying questions', () => {
      expect(didAskClarification('Would you like a todo app?')).toBe(true)
      expect(didAskClarification('Which option would you prefer?')).toBe(true)
      expect(didAskClarification('What kind of app do you need?')).toBe(true)
    })

    test('returns false for statements', () => {
      expect(didAskClarification("I'll create a todo app for you.")).toBe(false)
      expect(didAskClarification('Your app is ready!')).toBe(false)
    })
  })
})

describe('Eval Runner', () => {
  describe('runEval with mock responses', () => {
    test('passes eval when correct template selected', async () => {
      const mockResponse: MockAgentResponse = {
        text: "I'll create a todo app for you. Would you like me to customize anything?",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app', name: 'my-app' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)

      expect(result.passed).toBe(true)
      expect(result.score).toBeGreaterThan(70)
      expect(result.triggeredAntiPatterns).toHaveLength(0)
    })

    test('fails eval when wrong template selected', async () => {
      const mockResponse: MockAgentResponse = {
        text: "I'll create a kanban board for your tasks.",
        toolCalls: [
          { name: 'template.copy', params: { template: 'kanban', name: 'my-app' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)

      expect(result.passed).toBe(false)
      // Template selection criterion should fail
      const templateCriterion = result.criteriaResults.find(
        c => c.criterion.id.includes('template-selection')
      )
      expect(templateCriterion?.passed).toBe(false)
    })

    test('validates project name parameter', async () => {
      const mockResponse: MockAgentResponse = {
        text: "Creating your todo app named my-daily-tasks.",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app', name: 'my-daily-tasks' } },
        ],
      }

      const result = await runEval(EVAL_PARAMS_WITH_NAME, {}, mockResponse)

      const nameCriterion = result.criteriaResults.find(
        c => c.criterion.id === 'correct-name'
      )
      expect(nameCriterion?.passed).toBe(true)
    })

    test('handles ambiguous request evaluation', async () => {
      const mockResponse: MockAgentResponse = {
        text: "I can help with that! Would you prefer a task tracker (todo app), a project board (kanban), or something else?",
        toolCalls: [], // Should NOT call tools yet
      }

      const result = await runEval(EVAL_AMBIGUOUS_TEAM, {}, mockResponse)

      expect(result.passed).toBe(true)
      // Should have asked clarification
      const clarificationCriterion = result.criteriaResults.find(
        c => c.criterion.id === 'asked-clarification'
      )
      expect(clarificationCriterion?.passed).toBe(true)
    })
  })

  describe('runEvalSuite', () => {
    test('aggregates results correctly', async () => {
      const mockResponses = new Map<string, MockAgentResponse>()
      
      // This would need actual implementation to inject mock responses per eval
      // For now, test the structure
      const suite = await runEvalSuite(
        'Test Suite',
        [EVAL_TODO_DIRECT, EVAL_EXPENSE_DIRECT],
        { verbose: false }
      )

      expect(suite.name).toBe('Test Suite')
      expect(suite.results).toHaveLength(2)
      expect(suite.summary.total).toBe(2)
      expect(suite.byCategory['template-selection']).toBeDefined()
    })
  })

  describe('formatEvalReport', () => {
    test('generates readable report', async () => {
      const mockResponse: MockAgentResponse = {
        text: 'Todo app created!',
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)
      const suite = {
        name: 'Test',
        timestamp: new Date(),
        results: [result],
        summary: {
          total: 1,
          passed: 1,
          failed: 0,
          passRate: 100,
          averageScore: result.score,
          totalPoints: result.score,
          maxPoints: result.maxScore,
        },
        byCategory: {
          'template-selection': { total: 1, passed: 1, failed: 0, passRate: 100, averageScore: result.score },
          'tool-usage': { total: 0, passed: 0, failed: 0, passRate: 0, averageScore: 0 },
          'multi-turn': { total: 0, passed: 0, failed: 0, passRate: 0, averageScore: 0 },
          'edge-cases': { total: 0, passed: 0, failed: 0, passRate: 0, averageScore: 0 },
        },
      }

      const report = formatEvalReport(suite)

      expect(report).toContain('EVAL SUITE: Test')
      expect(report).toContain('SUMMARY')
      expect(report).toContain('Pass Rate')
    })
  })

  // ============================================
  // Global Penalty: Forbidden Runtime Commands
  // ============================================

  describe('global penalty for forbidden runtime commands', () => {
    test('applies 5% penalty when a non-runtime-safety eval runs forbidden commands', async () => {
      // Simulate: agent builds a todo app correctly BUT also runs "bun run build"
      const mockResponse: MockAgentResponse = {
        text: "I'll create a todo app for you. Would you like me to customize anything?",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app', name: 'my-app' } },
          { name: 'Bash', params: { command: 'bun run build' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)

      // Should have a global penalty
      expect(result.globalPenalties).toBeDefined()
      expect(result.globalPenalties!.length).toBe(1)
      expect(result.globalPenalties![0].id).toBe('forbidden-runtime-commands')
      expect(result.globalPenalties![0].percentagePenalty).toBe(5)
      // 5% of maxScore 100 = 5 points deducted
      expect(result.globalPenalties![0].pointsDeducted).toBe(5)
    })

    test('does not apply penalty when no forbidden commands are run', async () => {
      const mockResponse: MockAgentResponse = {
        text: "I'll create a todo app for you. Would you like me to customize anything?",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app', name: 'my-app' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)

      // No penalty
      expect(result.globalPenalties).toBeUndefined()
    })

    test('penalty reduces the final score by 5%', async () => {
      // Use EVAL_SEMANTIC_ORGANIZE which has NO vite anti-pattern,
      // so we can isolate the global penalty effect
      const cleanResponse: MockAgentResponse = {
        text: "I'll set up a todo app to help you stay organized. Would you like to customize anything?",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app' } },
        ],
      }

      const penaltyResponse: MockAgentResponse = {
        text: "I'll set up a todo app to help you stay organized. Would you like to customize anything?",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app' } },
          { name: 'Bash', params: { command: 'vite build' } },
        ],
      }

      const { EVAL_SEMANTIC_ORGANIZE } = await import('../test-cases')
      const cleanResult = await runEval(EVAL_SEMANTIC_ORGANIZE, {}, cleanResponse)
      const penaltyResult = await runEval(EVAL_SEMANTIC_ORGANIZE, {}, penaltyResponse)

      // Penalty result should be exactly 5 points lower (5% of 100)
      expect(penaltyResult.score).toBe(cleanResult.score - 5)
      expect(penaltyResult.globalPenalties).toBeDefined()
      expect(cleanResult.globalPenalties).toBeUndefined()
    })

    test('penalty includes details of which forbidden commands were run', async () => {
      const mockResponse: MockAgentResponse = {
        text: "Let me set this up for you.",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app' } },
          { name: 'Bash', params: { command: 'pkill -f vite' } },
          { name: 'Bash', params: { command: 'bun run dev' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)

      expect(result.globalPenalties).toBeDefined()
      expect(result.globalPenalties![0].details).toBeDefined()
      expect(result.globalPenalties![0].details!.length).toBe(2)
      expect(result.globalPenalties![0].details).toContain('pkill -f vite')
      expect(result.globalPenalties![0].details).toContain('bun run dev')
    })

    test('safe commands like cat .build.log do NOT trigger penalty', async () => {
      const mockResponse: MockAgentResponse = {
        text: "Let me check the build log.",
        toolCalls: [
          { name: 'template.copy', params: { template: 'todo-app' } },
          { name: 'Bash', params: { command: 'cat .build.log' } },
          { name: 'Bash', params: { command: 'tail -f .build.log' } },
        ],
      }

      const result = await runEval(EVAL_TODO_DIRECT, {}, mockResponse)

      expect(result.globalPenalties).toBeUndefined()
    })
  })
})

describe('Test Cases', () => {
  test('all evals have required fields', () => {
    for (const eval_ of ALL_EVALS) {
      expect(eval_.id).toBeTruthy()
      expect(eval_.name).toBeTruthy()
      expect(eval_.category).toBeTruthy()
      expect(eval_.input).toBeTruthy()
      expect(eval_.validationCriteria.length).toBeGreaterThan(0)
      expect(eval_.maxScore).toBeGreaterThan(0)
    }
  })

  test('validation criteria points sum to maxScore', () => {
    for (const eval_ of ALL_EVALS) {
      const totalPoints = eval_.validationCriteria.reduce(
        (sum, c) => sum + c.points,
        0
      )
      expect(totalPoints).toBe(eval_.maxScore)
    }
  })

  test('all templates in test cases are valid', () => {
    for (const eval_ of ALL_EVALS) {
      if (eval_.expectedTemplate) {
        expect(VALID_TEMPLATES).toContain(eval_.expectedTemplate)
      }
    }
  })

  test('runtime safety evals are included in ALL_EVALS', () => {
    for (const eval_ of RUNTIME_SAFETY_EVALS) {
      const found = ALL_EVALS.find((e) => e.id === eval_.id)
      expect(found).toBeDefined()
    }
  })
})

describe('Runtime Safety Validators', () => {
  describe('ranForbiddenRuntimeCommands', () => {
    test('detects vite dev command', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'vite dev' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('detects vite build command', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'vite build' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('detects bun run dev command', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'bun run dev' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('detects bun run build command', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'bun run build' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('detects kill commands', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'kill -9 12345' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('detects pkill commands', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'pkill -f vite' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('detects npm run dev command', () => {
      const toolCalls: ToolCall[] = [
        { name: 'shell', params: { command: 'npm run dev' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(true)
    })

    test('allows bun run generate (safe command)', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'bun run generate' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(false)
    })

    test('allows bunx tsc --noEmit (safe command)', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'bunx tsc --noEmit' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(false)
    })

    test('allows prisma commands (safe)', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'bunx prisma validate' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(false)
    })

    test('allows cat .build.log (safe diagnostic)', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'cat .build.log' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(false)
    })

    test('returns false for non-bash tool calls', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Read', params: { file_path: 'src/App.tsx' } },
        { name: 'Write', params: { file_path: 'src/App.tsx', content: 'test' } },
        { name: 'template.copy', params: { template: 'todo-app' } },
      ]
      expect(ranForbiddenRuntimeCommands(toolCalls)).toBe(false)
    })

    test('returns false for empty tool calls', () => {
      expect(ranForbiddenRuntimeCommands([])).toBe(false)
    })
  })

  describe('extractForbiddenCommands', () => {
    test('extracts specific forbidden commands', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'pkill -f vite' } },
        { name: 'Bash', params: { command: 'bun run dev' } },
        { name: 'Bash', params: { command: 'cat .build.log' } },
      ]
      const forbidden = extractForbiddenCommands(toolCalls)
      expect(forbidden).toHaveLength(2)
      expect(forbidden).toContain('pkill -f vite')
      expect(forbidden).toContain('bun run dev')
    })

    test('returns empty array when no forbidden commands', () => {
      const toolCalls: ToolCall[] = [
        { name: 'Bash', params: { command: 'bun run generate' } },
        { name: 'Read', params: { file_path: 'src/App.tsx' } },
      ]
      expect(extractForbiddenCommands(toolCalls)).toHaveLength(0)
    })
  })
})

describe('Runtime Safety Eval Runner', () => {
  test('passes when agent refuses to restart vite', async () => {
    const mockResponse: MockAgentResponse = {
      text: "I can't restart Vite because it's already running automatically in watch mode. Any file changes will trigger a rebuild within 1-2 seconds. If you're not seeing updates, let me check the build log for errors.",
      toolCalls: [], // No tools called - agent refused
    }

    const result = await runEval(EVAL_RESTART_VITE, {}, mockResponse)

    expect(result.passed).toBe(true)
    expect(result.triggeredAntiPatterns).toHaveLength(0)
  })

  test('fails when agent actually restarts vite', async () => {
    const mockResponse: MockAgentResponse = {
      text: "Sure, I'll restart Vite for you.",
      toolCalls: [
        { name: 'Bash', params: { command: 'pkill -f vite && vite dev' } },
      ],
    }

    const result = await runEval(EVAL_RESTART_VITE, {}, mockResponse)

    expect(result.passed).toBe(false)
    // The no-forbidden-runtime-commands criterion should fail
    const forbiddenCriterion = result.criteriaResults.find(
      (c) => c.criterion.id === 'no-forbidden-runtime-commands'
    )
    expect(forbiddenCriterion?.passed).toBe(false)
  })

  test('fails when agent runs bun run build', async () => {
    const mockResponse: MockAgentResponse = {
      text: "I'll build the project for you.",
      toolCalls: [
        { name: 'Bash', params: { command: 'bun run build' } },
      ],
    }

    const result = await runEval(EVAL_RUN_BUILD, {}, mockResponse)

    expect(result.passed).toBe(false)
  })

  test('passes when agent explains dev server is running', async () => {
    const mockResponse: MockAgentResponse = {
      text: "The dev server is already running! The project uses Vite in watch mode, so any changes you make will automatically trigger a rebuild. You don't need to start anything manually.",
      toolCalls: [],
    }

    const result = await runEval(EVAL_START_DEV_SERVER, {}, mockResponse)

    expect(result.passed).toBe(true)
  })

  // ============================================
  // Varied phrasing tests — ensures validators
  // don't false-fail on non-hardcoded wording
  // ============================================

  test('passes restart-vite eval with varied phrasing (no exact match phrases)', async () => {
    const mockResponse: MockAgentResponse = {
      text: "The system takes care of rebuilding for you whenever you save a file. There's a background process that picks up changes and compiles them right away, so you won't need to do anything manual.",
      toolCalls: [],
    }

    const result = await runEval(EVAL_RESTART_VITE, {}, mockResponse)

    // Should pass — agent communicated the concept without using exact hardcoded phrases
    expect(result.passed).toBe(true)
    const autoRebuildCriterion = result.criteriaResults.find(
      (c) => c.criterion.id === 'explained-auto-rebuild'
    )
    expect(autoRebuildCriterion?.passed).toBe(true)
  })

  test('passes start-dev-server eval with varied phrasing', async () => {
    const mockResponse: MockAgentResponse = {
      text: "A server is currently serving your application. The platform infrastructure handles this for you — it's up and running, so no action is needed on your part.",
      toolCalls: [],
    }

    const result = await runEval(EVAL_START_DEV_SERVER, {}, mockResponse)

    expect(result.passed).toBe(true)
  })

  test('does not false-fail run-build when agent reads .build.log', async () => {
    const mockResponse: MockAgentResponse = {
      text: "The build process runs on its own. Let me check if there are any errors in the build output.",
      toolCalls: [
        { name: 'Bash', params: { command: 'cat .build.log' } },
      ],
    }

    const result = await runEval(EVAL_RUN_BUILD, {}, mockResponse)

    // 'cat .build.log' contains 'build' but should NOT be flagged as running a build command
    const buildCriterion = result.criteriaResults.find(
      (c) => c.criterion.id === 'did-not-run-build'
    )
    expect(buildCriterion?.passed).toBe(true)
  })

  test('does not false-fail start-dev-server when agent reads vite config', async () => {
    const mockResponse: MockAgentResponse = {
      text: "The server is currently active and serving your app. Let me check the vite configuration to make sure everything is set up correctly.",
      toolCalls: [
        { name: 'Read', params: { file_path: 'vite.config.ts' } },
      ],
    }

    const result = await runEval(EVAL_START_DEV_SERVER, {}, mockResponse)

    // Reading vite.config.ts should NOT be flagged as starting a dev server
    const serverCriterion = result.criteriaResults.find(
      (c) => c.criterion.id === 'did-not-start-server'
    )
    expect(serverCriterion?.passed).toBe(true)
  })

  test('passes changes-not-showing when agent diagnoses with varied language', async () => {
    const mockResponse: MockAgentResponse = {
      text: "Let me take a look at what might be going on. I'll examine the build output to see if there are any compilation issues preventing your updates from appearing.",
      toolCalls: [
        { name: 'Bash', params: { command: 'cat .build.log' } },
      ],
    }

    const result = await runEval(EVAL_CHANGES_NOT_SHOWING, {}, mockResponse)

    expect(result.passed).toBe(true)
  })

  test('passes preview-broken when agent diagnoses with investigation language', async () => {
    const mockResponse: MockAgentResponse = {
      text: "Let me investigate what's causing the blank page. I'll look at the source files and check for any syntax problems that might be breaking the build.",
      toolCalls: [
        { name: 'Read', params: { file_path: '.build.log' } },
      ],
    }

    const result = await runEval(EVAL_PREVIEW_BROKEN, {}, mockResponse)

    expect(result.passed).toBe(true)
  })

  test('preview-broken requires at least 2 diagnostic concepts (not just "error")', async () => {
    const mockResponse: MockAgentResponse = {
      // Only mentions one generic concept ("error") — should not be enough
      text: "There seems to be an error.",
      toolCalls: [],
    }

    const result = await runEval(EVAL_PREVIEW_BROKEN, {}, mockResponse)

    // 'diagnosed-before-acting' should fail — only 1 diagnostic concept
    const diagCriterion = result.criteriaResults.find(
      (c) => c.criterion.id === 'diagnosed-before-acting'
    )
    expect(diagCriterion?.passed).toBe(false)
  })
})
