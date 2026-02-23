/**
 * Agent Runtime Evaluation Types
 *
 * Modeled after the project-runtime eval framework (packages/mcp/src/evals/types.ts)
 * but adapted for agent-runtime concerns: canvas creation, memory, skills,
 * personality updates, and multi-turn conversations.
 */

// ---------------------------------------------------------------------------
// Eval Definition
// ---------------------------------------------------------------------------

export type EvalCategory =
  | 'canvas'
  | 'complex'
  | 'memory'
  | 'personality'
  | 'skill'
  | 'multiturn'
  | 'tool-usage'
  | 'edge-cases'
  | 'mcp-discovery'
  | 'mcp-orchestration'

export type ValidationPhase = 'intention' | 'execution' | 'interaction'

export interface AgentEval {
  id: string
  name: string
  category: EvalCategory
  /** Difficulty 1-5 */
  level: 1 | 2 | 3 | 4 | 5
  /** The user prompt to send to the agent */
  input: string
  /** Optional conversation history (for multi-turn) */
  conversationHistory?: ConversationTurn[]
  /** Validation criteria (scored) */
  validationCriteria: ValidationCriterion[]
  /** Anti-patterns that should NOT happen */
  antiPatterns?: string[]
  /** Maximum score */
  maxScore: number
  /** Per-eval tool mock overrides (merged with defaults by buildMockPayload) */
  toolMocks?: import('./tool-mocks').ToolMockMap
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ValidationCriterion {
  id: string
  description: string
  points: number
  phase?: ValidationPhase
  validate: (result: EvalResult) => boolean
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  name: string
  input: Record<string, unknown>
  output: unknown
  durationMs?: number
  error?: boolean
}

export interface EvalResult {
  eval: AgentEval
  passed: boolean
  score: number
  maxScore: number
  percentage: number
  responseText: string
  toolCalls: ToolCallRecord[]
  criteriaResults: CriterionResult[]
  triggeredAntiPatterns: string[]
  timing: {
    startTime: number
    endTime: number
    durationMs: number
  }
  metrics: EvalMetrics
  errors?: string[]
  /** The workspace directory used for this eval */
  workspaceDir?: string
  phaseScores?: {
    intention: { score: number; maxScore: number; percentage: number }
    execution: { score: number; maxScore: number; percentage: number }
  }
}

export interface CriterionResult {
  criterion: ValidationCriterion
  passed: boolean
  pointsEarned: number
}

export interface EvalMetrics {
  toolCallCount: number
  successfulToolCalls: number
  failedToolCalls: number
  iterations: number
  tokens: { input: number; output: number; total: number }
  timing: { totalMs: number }
}

// ---------------------------------------------------------------------------
// Aggregated suite
// ---------------------------------------------------------------------------

export interface EvalSuiteResult {
  name: string
  timestamp: string
  model: string
  results: EvalResult[]
  summary: {
    total: number
    passed: number
    failed: number
    passRate: number
    avgScore: number
    totalPoints: number
    maxPoints: number
  }
  byCategory: Record<string, CategorySummary>
  cost: CostSummary
}

export interface CategorySummary {
  total: number
  passed: number
  failed: number
  passRate: number
  avgScore: number
}

export interface CostSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  costPerEval: number
}
