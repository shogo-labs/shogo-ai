/**
 * Agent Evaluation Types
 *
 * Type definitions for the Shogo agent evaluation framework.
 * Based on best practices from DeepEval and Braintrust.
 */

/**
 * A single evaluation test case
 */
export interface AgentEval {
  /** Unique identifier for the eval */
  id: string
  /** Human-readable name */
  name: string
  /** Category: template-selection, tool-usage, multi-turn, edge-cases */
  category: EvalCategory
  /** Difficulty level */
  level: 1 | 2 | 3 | 4
  /** The user input/prompt */
  input: string
  /** Previous conversation turns (for multi-turn evals) */
  conversationHistory?: ConversationTurn[]
  /** Expected template to be selected (if applicable) */
  expectedTemplate?: string
  /** Expected tool calls */
  expectedToolCalls: ExpectedToolCall[]
  /** Validation criteria */
  validationCriteria: ValidationCriterion[]
  /** Things that should NOT happen */
  antiPatterns?: string[]
  /** Alternative inputs that should produce same result */
  variations?: string[]
  /** Maximum score for this eval */
  maxScore: number
}

export type EvalCategory =
  | 'template-selection'
  | 'tool-usage'
  | 'multi-turn'
  | 'edge-cases'

/**
 * A conversation turn for multi-turn evals
 */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
}

/**
 * Expected tool call specification
 */
export interface ExpectedToolCall {
  /** Tool name (e.g., "template.copy") */
  name: string
  /** Expected parameters (partial match) */
  params?: Record<string, unknown>
  /** Whether this call is required */
  required: boolean
  /** Order in sequence (if multiple tools expected) */
  order?: number
}

/**
 * Actual tool call from agent
 */
export interface ToolCall {
  /** Tool name */
  name: string
  /** Actual parameters passed */
  params: Record<string, unknown>
  /** Result of the tool call */
  result?: unknown
  /** Timestamp */
  timestamp?: number
}

/**
 * Validation criterion for scoring
 */
export interface ValidationCriterion {
  /** Unique ID */
  id: string
  /** Description of what's being validated */
  description: string
  /** Points for this criterion */
  points: number
  /** Validation function */
  validate: (result: EvalResult) => boolean
}

/**
 * Result from running an eval
 */
export interface EvalResult {
  /** The eval that was run */
  eval: AgentEval
  /** Whether it passed overall */
  passed: boolean
  /** Score achieved */
  score: number
  /** Maximum possible score */
  maxScore: number
  /** Percentage score */
  percentage: number
  /** Tool calls made by agent */
  toolCalls: ToolCall[]
  /** Final response text */
  responseText: string
  /** Which criteria passed/failed */
  criteriaResults: CriterionResult[]
  /** Anti-patterns that were triggered */
  triggeredAntiPatterns: string[]
  /** Timing information */
  timing: {
    startTime: number
    endTime: number
    durationMs: number
  }
  /** Performance metrics */
  metrics: EvalMetrics
  /** Any errors encountered */
  errors?: string[]
}

/**
 * Performance metrics for an eval run
 */
export interface EvalMetrics {
  /** Total number of tool calls */
  toolCallCount: number
  /** Number of agent steps/turns */
  stepCount: number
  /** Token usage (if available from provider) */
  tokens: {
    input: number
    output: number
    total: number
  }
  /** Time metrics in milliseconds */
  timing: {
    totalMs: number
    firstToolCallMs: number | null
    avgToolCallMs: number | null
  }
}

/**
 * Result for a single validation criterion
 */
export interface CriterionResult {
  criterion: ValidationCriterion
  passed: boolean
  pointsEarned: number
}

/**
 * Aggregated results from running multiple evals
 */
export interface EvalSuiteResult {
  /** Suite name */
  name: string
  /** When the suite was run */
  timestamp: Date
  /** Individual eval results */
  results: EvalResult[]
  /** Summary statistics */
  summary: {
    total: number
    passed: number
    failed: number
    passRate: number
    averageScore: number
    totalPoints: number
    maxPoints: number
  }
  /** Results by category */
  byCategory: Record<EvalCategory, CategorySummary>
}

/**
 * Summary for a category
 */
export interface CategorySummary {
  total: number
  passed: number
  failed: number
  passRate: number
  averageScore: number
}

/**
 * Tool Correctness Score (inspired by DeepEval)
 */
export interface ToolCorrectnessScore {
  /** Did all required tools get called? */
  toolSelectionAccuracy: number
  /** Were parameters correct? */
  parameterAccuracy: number
  /** Tools called that weren't expected */
  unexpectedTools: ToolCall[]
  /** Required tools that weren't called */
  missingTools: string[]
  /** Overall score 0-1 */
  overallScore: number
}

/**
 * Template Selection Score
 */
export interface TemplateSelectionScore {
  /** Expected template */
  expected: string
  /** Actual template selected */
  actual: string | null
  /** Whether it matched */
  matched: boolean
  /** Partial credit (for related templates) */
  score: number
}

/**
 * Metrics for tracking agent performance over time
 */
export interface AgentMetrics {
  /** Template selection accuracy */
  templateSelectionAccuracy: number
  /** Tool call success rate */
  toolCallSuccessRate: number
  /** Parameter accuracy */
  parameterAccuracy: number
  /** First-try success rate */
  firstTrySuccessRate: number
  /** Clarification rate (% needing clarification) */
  clarificationRate: number
  /** Average response latency */
  averageLatencyMs: number
}
