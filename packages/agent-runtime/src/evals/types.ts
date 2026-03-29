// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Evaluation Types
 *
 * Evaluation types for agent-runtime concerns: canvas creation, memory, skills,
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
  | 'tool-system'
  | 'tool-routing'
  | 'template'
  | 'code-agent'
  | 'canvas-v2'
  | 'edit-file'
  | 'channel-connect'

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
  /** Files to write into the workspace before running the eval (path relative to workspace root -> content) */
  workspaceFiles?: Record<string, string>
  /** Visual mode to activate before running the eval (e.g. 'canvas'). Defaults to 'none'. */
  initialMode?: 'canvas' | 'app' | 'none'
  /** Arbitrary tags for filtering (e.g. 'view-only', 'interactive') */
  tags?: string[]
  /** Agent mode required for this eval (e.g. 'basic', 'advanced') */
  requiredAgent?: string
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

export interface RuntimeCheckResults {
  /** Whether the skill server /health endpoint responded with { ok: true }. null = no skill server. */
  serverHealthy: boolean | null
  healthEndpoint: boolean
  /** Whether GET /api/{model} returned { ok: true, items: [...] } for all models. */
  canListModels: boolean
  /** Whether POST /api/{model} succeeded for at least one model. */
  canCreateRecord: boolean
  /** Whether canvas code references the correct skill server port. null = no canvas. */
  canvasPortCorrect: boolean | null
  errors: string[]
}

export interface EvalResult {
  eval: AgentEval
  passed: boolean
  score: number
  maxScore: number
  percentage: number
  responseText: string
  /** All tool calls across every turn (history + final). Use for intention checks. */
  toolCalls: ToolCallRecord[]
  /** Tool calls from only the final evaluated turn. Use for negative execution checks. */
  finalTurnToolCalls: ToolCallRecord[]
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
  /** Post-eval runtime validation results. Adds bonus criteria to score. */
  runtimeChecks?: RuntimeCheckResults
  runtimeWarnings?: string[]
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
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
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
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalOutputTokens: number
  totalCost: number
  costPerEval: number
}
