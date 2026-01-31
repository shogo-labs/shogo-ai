/**
 * Validation Functions for Agent Evals
 *
 * These functions check specific aspects of agent behavior.
 */

import type {
  EvalResult,
  ToolCall,
  ExpectedToolCall,
  ToolCorrectnessScore,
  TemplateSelectionScore,
  ValidationCriterion,
  ValidationPhase,
} from './types'

/**
 * Valid template names
 */
export const VALID_TEMPLATES = [
  'todo-app',
  'expense-tracker',
  'crm',
  'inventory',
  'kanban',
  'ai-chat',
  'form-builder',
  'feedback-form',
  'booking-app',
] as const

export type ValidTemplate = (typeof VALID_TEMPLATES)[number]

/**
 * Related templates (for partial credit)
 */
export const TEMPLATE_SIMILARITY: Record<ValidTemplate, ValidTemplate[]> = {
  'todo-app': ['kanban'], // Both handle tasks
  'expense-tracker': ['inventory'], // Both track items
  'crm': ['booking-app'], // Both handle clients
  'inventory': ['expense-tracker'],
  'kanban': ['todo-app'],
  'ai-chat': [],
  'form-builder': ['feedback-form'],
  'feedback-form': ['form-builder'],
  'booking-app': ['crm'],
}

/**
 * Valid theme names
 */
export const VALID_THEMES = ['default', 'lavender', 'glacier'] as const

/**
 * Theme color mappings
 */
export const THEME_MAPPINGS: Record<string, string> = {
  purple: 'lavender',
  violet: 'lavender',
  blue: 'glacier',
  cool: 'glacier',
  default: 'default',
  standard: 'default',
}

/**
 * Evaluate tool correctness (DeepEval-inspired)
 */
export function evaluateToolCorrectness(
  expected: ExpectedToolCall[],
  actual: ToolCall[]
): ToolCorrectnessScore {
  const requiredTools = expected.filter((t) => t.required)
  const actualNames = actual.map((t) => t.name)

  // Check required tools were called
  const missingTools = requiredTools
    .filter((t) => !actualNames.includes(t.name))
    .map((t) => t.name)

  const toolSelectionAccuracy =
    requiredTools.length > 0
      ? (requiredTools.length - missingTools.length) / requiredTools.length
      : 1.0

  // Check parameter accuracy for called tools
  const paramScores = actual.map((call) => {
    const expectedCall = expected.find((e) => e.name === call.name)
    if (!expectedCall?.params) return 1.0
    return calculateParamSimilarity(expectedCall.params, call.params)
  })

  const parameterAccuracy =
    paramScores.length > 0
      ? paramScores.reduce((a, b) => a + b, 0) / paramScores.length
      : 1.0

  // Find unexpected tools
  const expectedNames = expected.map((e) => e.name)
  const unexpectedTools = actual.filter((a) => !expectedNames.includes(a.name))

  // Calculate overall score
  const unexpectedPenalty = unexpectedTools.length * 0.1
  const overallScore = Math.max(
    0,
    (toolSelectionAccuracy * 0.5 + parameterAccuracy * 0.5 - unexpectedPenalty)
  )

  return {
    toolSelectionAccuracy,
    parameterAccuracy,
    unexpectedTools,
    missingTools,
    overallScore,
  }
}

/**
 * Calculate parameter similarity between expected and actual
 */
export function calculateParamSimilarity(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): number {
  const expectedKeys = Object.keys(expected)
  if (expectedKeys.length === 0) return 1.0

  let matches = 0
  for (const key of expectedKeys) {
    const expectedValue = expected[key]
    const actualValue = actual[key]

    if (expectedValue === actualValue) {
      matches++
    } else if (
      typeof expectedValue === 'string' &&
      typeof actualValue === 'string'
    ) {
      // Partial match for strings
      if (actualValue.toLowerCase().includes(expectedValue.toLowerCase())) {
        matches += 0.5
      }
    }
  }

  return matches / expectedKeys.length
}

/**
 * Evaluate template selection
 */
export function evaluateTemplateSelection(
  expected: string,
  actual: string | null
): TemplateSelectionScore {
  if (!actual) {
    return {
      expected,
      actual: null,
      matched: false,
      score: 0,
    }
  }

  if (actual === expected) {
    return {
      expected,
      actual,
      matched: true,
      score: 1.0,
    }
  }

  // Check for partial credit (related templates)
  const related = TEMPLATE_SIMILARITY[expected as ValidTemplate] || []
  if (related.includes(actual as ValidTemplate)) {
    return {
      expected,
      actual,
      matched: false,
      score: 0.5, // Partial credit
    }
  }

  return {
    expected,
    actual,
    matched: false,
    score: 0,
  }
}

/**
 * Extract template from tool calls
 */
export function extractSelectedTemplate(toolCalls: ToolCall[]): string | null {
  const copyCall = toolCalls.find((t) => t.name === 'template.copy')
  if (copyCall?.params?.template) {
    return copyCall.params.template as string
  }
  return null
}

/**
 * Check if agent asked clarifying questions
 */
export function didAskClarification(responseText: string): boolean {
  const clarificationPatterns = [
    /would you (like|prefer)/i,
    /which (one|option)/i,
    /could you (tell|clarify)/i,
    /what (kind|type) of/i,
    /do you (want|need)/i,
    /\?.*\?/s, // Multiple questions
  ]

  return clarificationPatterns.some((pattern) => pattern.test(responseText))
}

/**
 * Check if agent mentioned specific features
 */
export function mentionedFeatures(
  responseText: string,
  features: string[]
): boolean {
  const textLower = responseText.toLowerCase()
  return features.some((f) => textLower.includes(f.toLowerCase()))
}

/**
 * Check if agent ran manual commands (shouldn't after template.copy)
 */
export function ranManualCommands(toolCalls: ToolCall[]): boolean {
  const manualCommands = ['bun install', 'prisma', 'npm install', 'yarn']
  
  return toolCalls.some((call) => {
    // Check for Bash tool (case-insensitive)
    if (call.name.toLowerCase() === 'bash' || call.name.toLowerCase() === 'shell') {
      const command = String(call.params?.command || '')
      return manualCommands.some((mc) => command.includes(mc))
    }
    return false
  })
}

// ============================================
// Pre-built Validation Criteria
// ============================================

/**
 * Criterion: Correct template was selected
 * Phase: intention (choosing the right template shows understanding)
 */
export function createTemplateSelectionCriterion(
  expectedTemplate: string,
  points: number = 40,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: `template-selection-${expectedTemplate}`,
    description: `Selected correct template: ${expectedTemplate}`,
    points,
    phase,
    validate: (result) => {
      const selected = extractSelectedTemplate(result.toolCalls)
      return selected === expectedTemplate
    },
  }
}

/**
 * Criterion: No unnecessary clarifying questions
 * Phase: intention (knowing when NOT to ask shows understanding)
 */
export function createNoClarificationCriterion(
  points: number = 20,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'no-unnecessary-clarification',
    description: 'Did not ask unnecessary clarifying questions',
    points,
    phase,
    validate: (result) => !didAskClarification(result.responseText),
  }
}

/**
 * Criterion: Used template.copy with correct params
 * Phase: intention (using correct params shows understanding)
 */
export function createToolUsageCriterion(
  expectedParams: Record<string, unknown>,
  points: number = 20,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'correct-tool-usage',
    description: 'Called template.copy with correct parameters',
    points,
    phase,
    validate: (result) => {
      const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
      if (!copyCall) return false
      return calculateParamSimilarity(expectedParams, copyCall.params) >= 0.8
    },
  }
}

/**
 * Criterion: No manual commands after template.copy
 * Phase: intention (knowing not to run extra commands shows understanding)
 */
export function createNoManualCommandsCriterion(
  points: number = 15,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'no-manual-commands',
    description: 'Did not run manual setup commands',
    points,
    phase,
    validate: (result) => !ranManualCommands(result.toolCalls),
  }
}

/**
 * Criterion: Offered customization options
 * Phase: intention (proactive helpfulness shows understanding of user needs)
 */
export function createOfferedCustomizationCriterion(
  points: number = 10,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'offered-customization',
    description: 'Offered to customize after setup',
    points,
    phase,
    validate: (result) => {
      const customizationPhrases = [
        'customize',
        'modify',
        'change',
        'adjust',
        'would you like',
        'want me to',
      ]
      return customizationPhrases.some((phrase) =>
        result.responseText.toLowerCase().includes(phrase)
      )
    },
  }
}

/**
 * Criterion: Proper error handling
 * Phase: intention (graceful error handling shows good understanding)
 */
export function createErrorHandlingCriterion(
  points: number = 25,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'graceful-error-handling',
    description: 'Handled errors gracefully with alternatives',
    points,
    phase,
    validate: (result) => {
      // If there were errors, check response offers alternatives
      if (result.errors && result.errors.length > 0) {
        const hasAlternative =
          result.responseText.includes('instead') ||
          result.responseText.includes('alternative') ||
          result.responseText.includes('try') ||
          result.responseText.includes('available')
        return hasAlternative
      }
      return true
    },
  }
}
