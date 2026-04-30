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
  | 'gaia'
  | 'webarena'
  | 'tau2-bench'
  | 'terminal-bench'
  | 'feature-bench'
  | 'subagent'
  | 'business-user'
  | 'adversarial'
  | 'freelancer'
  | 'cross-cutting'
  | 'startup-cto'
  | 'content-creator'
  | 'nonprofit'
  | 'event-planner'
  | 'subagent-coordination'
  | 'teammate-coordination'
  | 'plan'

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
  /** Seed workspace with the runtime template (Vite + React + Tailwind + shadcn/ui). Provides index.html, package.json, tsconfig, etc. */
  useRuntimeTemplate?: boolean
  /**
   * @deprecated The legacy `.shogo/server/` skill server has been retired
   * — every workspace ships with its own backend at root `server.tsx`.
   * Setting this flag now just signals "this eval exercises the API
   * server" so the runner runs full server / route / CRUD checks.
   */
  useSkillServer?: boolean
  /** Visual mode to activate before running the eval (e.g. 'canvas'). Defaults to 'none'. */
  initialMode?: 'canvas' | 'app' | 'plan' | 'none'
  /** Interaction mode sent in the request body (e.g. 'plan' for plan-mode evals). */
  interactionMode?: 'agent' | 'plan' | 'ask'
  /** Pipeline name — evals sharing a pipeline run sequentially on one worker, each inheriting the prior phase's workspace. */
  pipeline?: string
  /** 1-based ordering within a pipeline. Phase 1 gets full workspace setup; phase 2+ skip cleanup and use pipelineFiles. */
  pipelinePhase?: number
  /** Files to overlay when running in pipeline mode (delta only — new data files the agent wouldn't produce). */
  pipelineFiles?: Record<string, string>
  /** Arbitrary tags for filtering (e.g. 'view-only', 'interactive') */
  tags?: string[]
  /** Agent mode required for this eval (e.g. 'basic', 'advanced') */
  requiredAgent?: string
  /** Pre-defined responses for ask_user calls. When the agent calls ask_user,
   *  the runner sends the next response as a follow-up user message.
   *  Responses are consumed in order; if exhausted, subsequent ask_user calls get no response. */
  askUserResponses?: string[]
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
  /** True when this tool call was made by a subagent, not the main agent directly. */
  viaSubagent?: boolean
}

export interface ModelCheckResult {
  model: string
  canList: boolean
  canCreate: boolean
  roundTripOk: boolean
}

export interface WorkspaceIntegrity {
  schema: boolean
  schemaHasModels: boolean
  generated: boolean
  server: boolean
  db: boolean
  prismaClient: boolean
}

export interface ViteBuildReadiness {
  hasPackageJson: boolean
  hasViteConfig: boolean
  hasAppTsx: boolean
  hasTsConfig: boolean
  hasNodeModules: boolean
  hasViteBin: boolean
  ready: boolean
}

export interface RuntimeCheckResults {
  /** Whether the skill server /health endpoint responded with { ok: true }. null = no skill server. */
  serverHealthy: boolean | null
  healthEndpoint: boolean
  /** Whether GET /api/{model} returned { ok: true, items: [...] } for all models. */
  canListModels: boolean
  /** Whether POST /api/{model} succeeded for at least one model. */
  canCreateRecord: boolean
  /** Per-model CRUD results. */
  modelResults: ModelCheckResult[]
  /** Models from schema that have no corresponding route. */
  missingRoutes: string[]
  /** Canvas fetch() URLs that don't match any discovered route. */
  canvasOrphanedFetches: string[]
  /** Whether all canvas fetch() URLs target valid routes. null = no canvas fetches. */
  canvasFetchesValid: boolean | null
  /** Workspace file integrity (schema, generated/, server, db, prisma client). */
  workspaceIntegrity: WorkspaceIntegrity | null
  /** Whether canvas code references the correct skill server port. null = no canvas. */
  canvasPortCorrect: boolean | null
  /** Whether all src/ TS/TSX files transpile without syntax errors. null = no src/ files. */
  canvasCompiles: boolean | null
  /** Individual compile errors (file path + message) when canvasCompiles is false. */
  canvasCompileErrors: string[]
  /** Vite build readiness — template files + deps present. null = check not run. */
  viteBuildReadiness: ViteBuildReadiness | null
  errors: string[]
}

export interface PromptBreakdownSection {
  label: string
  zone: 'stable' | 'dynamic'
  chars: number
  estTokens: number
}

export interface PromptBreakdown {
  sections: PromptBreakdownSection[]
  totalChars: number
  totalEstTokens: number
  toolSchemaChars: number
  toolSchemaEstTokens: number
  toolCount: number
  grandEstTokens: number
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
  /** Tool calls grouped by turn index for per-turn inspection. */
  perTurnToolCalls: ToolCallRecord[][]
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
  /** Per-section prompt token breakdown from the first turn. */
  promptBreakdown?: PromptBreakdown
}

export interface CriterionResult {
  criterion: ValidationCriterion
  passed: boolean
  pointsEarned: number
}

export interface ContainerResourceMetrics {
  /** Peak CPU usage in millicores (1000m = 1 CPU core). */
  peakCpuMillicores: number
  /** Average CPU usage in millicores. */
  avgCpuMillicores: number
  /** Peak memory usage in MiB. */
  peakMemoryMiB: number
  /** Average memory usage in MiB. */
  avgMemoryMiB: number
  /** Number of samples collected during the eval. */
  samples: number
}

export interface EvalMetrics {
  toolCallCount: number
  successfulToolCalls: number
  failedToolCalls: number
  iterations: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  timing: { totalMs: number }
  /** Docker container CPU/memory stats collected during the eval run. */
  resourceMetrics?: ContainerResourceMetrics
}

// ---------------------------------------------------------------------------
// Aggregated suite
// ---------------------------------------------------------------------------

export interface ResourceSummary {
  peakCpuMillicores: number
  avgCpuMillicores: number
  peakMemoryMiB: number
  avgMemoryMiB: number
}

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
  resources?: ResourceSummary
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
