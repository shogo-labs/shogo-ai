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

/**
 * Forbidden runtime commands that the agent should NEVER execute.
 * These would break the managed vite build --watch process, the Hono API server,
 * or other managed infrastructure inside the project runtime container.
 */
export const FORBIDDEN_RUNTIME_COMMANDS = [
  // Vite commands (already running in watch mode)
  'vite dev',
  'vite build',
  'vite --watch',
  'vite serve',
  'npx vite',
  'bunx vite',
  // Dev/build scripts (handled by watch mode)
  'bun run dev',
  'bun run build',
  'npm run dev',
  'npm run build',
  'yarn dev',
  'yarn build',
  // Process killing (would kill managed infrastructure)
  'kill ',
  'pkill',
  'killall',
  // Server restart commands
  'pm2 restart',
  'systemctl restart',
] as const

/**
 * Check if agent ran forbidden runtime commands that would break managed infrastructure.
 * The project runtime has a managed vite build --watch process, Hono API server, etc.
 * The agent should never restart, kill, or replace these.
 */
export function ranForbiddenRuntimeCommands(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((call) => {
    const name = call.name.toLowerCase()
    if (name === 'bash' || name === 'shell') {
      const command = String(call.params?.command || '').toLowerCase()
      return FORBIDDEN_RUNTIME_COMMANDS.some((fc) => command.includes(fc.toLowerCase()))
    }
    return false
  })
}

/**
 * Extract which specific forbidden commands were attempted
 */
export function extractForbiddenCommands(toolCalls: ToolCall[]): string[] {
  const found: string[] = []
  for (const call of toolCalls) {
    const name = call.name.toLowerCase()
    if (name === 'bash' || name === 'shell') {
      const command = String(call.params?.command || '').toLowerCase()
      for (const fc of FORBIDDEN_RUNTIME_COMMANDS) {
        if (command.includes(fc.toLowerCase())) {
          found.push(String(call.params?.command || ''))
          break
        }
      }
    }
  }
  return found
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

/**
 * Criterion: No forbidden runtime commands
 * Phase: intention (knowing NOT to run destructive commands shows understanding of the environment)
 * 
 * The project runs inside a managed container with:
 * - vite build --watch (auto-rebuilds on file changes)
 * - Hono API server (serves frontend + API)
 * The agent should never restart, kill, or replace these processes.
 */
export function createNoForbiddenRuntimeCommandsCriterion(
  points: number = 40,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'no-forbidden-runtime-commands',
    description: 'Did not run forbidden runtime commands (vite restart, build, kill, etc.)',
    points,
    phase,
    validate: (result) => !ranForbiddenRuntimeCommands(result.toolCalls),
  }
}

/**
 * Criterion: Explained why the command is not needed
 * Phase: intention (educating the user shows good understanding)
 * 
 * Uses a combination of phrase matching and regex patterns to avoid
 * false failures from hardcoded strings. The agent just needs to
 * communicate the CONCEPT that builds/restarts are handled for them.
 */
export function createExplainedAutoRebuildCriterion(
  points: number = 30,
  phase: ValidationPhase = 'intention'
): ValidationCriterion {
  return {
    id: 'explained-auto-rebuild',
    description: 'Explained that rebuilds/restarts are automatic',
    points,
    phase,
    validate: (result) => {
      const text = result.responseText.toLowerCase()

      // Phrase matching: any of these indicate the agent explained the concept
      const phrases = [
        // Direct auto-rebuild references
        'automatic', 'automatically', 'auto-rebuild', 'auto rebuild',
        'watch mode', 'watch process', 'file watcher', 'build watcher',
        'vite build --watch',
        // Already running / not needed
        'already running', 'already started', 'already active',
        'already handled', 'already taken care',
        'not needed', 'not necessary', 'not required', 'unnecessary',
        "don't need to", "no need to", "doesn't need to", "won't need to",
        "shouldn't need to", "never need to",
        // Managed/handled by system
        'handled by', 'managed by', 'taken care of', 'takes care of',
        'handled for you', 'managed for you', 'done for you',
        'built-in', 'built in', 'baked in',
        // Rebuild explanations
        'builds automatically', 'rebuilds when', 'rebuilds on',
        'rebuild on save', 'rebuild on change', 'rebuilds automatically',
        'detects changes', 'picks up changes', 'reflects changes',
        // Platform/runtime references
        'runtime handles', 'runtime manages', 'platform handles',
        'platform manages', 'system handles', 'system manages',
        'infrastructure', 'container',
      ]

      if (phrases.some((p) => text.includes(p))) return true

      // Regex patterns: catch varied phrasing the phrases might miss
      const patterns = [
        /\b(rebuild|build|restart)s?\b.{0,20}\b(auto|on its own|by itself|for you)\b/,
        /\b(no|don'?t|shouldn'?t|won'?t|never)\b.{0,30}\b(need|have) to\b.{0,20}\b(build|restart|run|start)\b/,
        /\b(already|currently)\b.{0,15}\b(running|active|started|up)\b/,
        /\bhandle[sd]?\b.{0,20}\b(by the|for you|automatically)\b/,
        /\b(file|code)\s+(change|save|edit)s?\b.{0,30}\b(trigger|cause|start|kick off)\b/,
        /\bwhen you\b.{0,20}\b(save|edit|change|modify)\b/,
      ]

      return patterns.some((p) => p.test(text))
    },
  }
}
