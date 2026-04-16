// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Model Router — Spawn-Time Sub-Agent Model Selection
 *
 * Classifies a sub-agent task's complexity at spawn time and selects the
 * cheapest model capable of handling it. The main agent always runs on the
 * user's chosen model; this router only fires when spawning sub-agents.
 *
 * Uses pure heuristics (no LLM call), runs synchronously in <1ms,
 * and includes automatic fallback escalation when a cheaper model
 * fails the sub-agent task.
 */

import { getModelTier, getModelEntry, AUTO_MODEL_ID, type ModelTier } from '@shogo/model-catalog'
import thresholdsJson from './routing-thresholds.json'

export { AUTO_MODEL_ID }

// ---------------------------------------------------------------------------
// Config (loaded from JSON, overridable at runtime)
// ---------------------------------------------------------------------------

export interface RoutingConfig {
  contextFloors: Record<string, { maxEffectiveContext: number }>
  highPrecisionTools: string[]
  confidence: { highThreshold: number }
  escalation: { maxFallbackRetries: number }
}

let _config: RoutingConfig = thresholdsJson as any

export function getRoutingConfig(): RoutingConfig {
  return _config
}

export function setRoutingConfig(config: RoutingConfig): void {
  _config = config
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplexityTier = 'simple' | 'moderate' | 'complex'

export interface RoutingDecision {
  spawnId: string
  subagentType: string
  signals: Record<string, number>
  confidence: number
  classifiedTier: ComplexityTier
  selectedModel: string
  reason: string
  contextTokens: number
  highPrecisionToolDetected?: string
  fallbackTriggered: boolean
  fallbackReason?: string
  escalatedFrom?: string
}

export interface SpawnClassificationInput {
  /** The task prompt / directive given to the sub-agent */
  prompt: string
  /** Sub-agent type name (e.g. 'explore', 'general-purpose', 'code-reviewer', 'fork') */
  subagentType: string
  /** Tool names available to the sub-agent */
  toolNames?: string[]
  /** Estimated context tokens being passed to the sub-agent */
  contextTokens: number
}

export interface ModelTierMap {
  economy: string
  standard: string
  premium: string
}

// ---------------------------------------------------------------------------
// Signal weights (tuned for spawn-time task classification)
// ---------------------------------------------------------------------------

const SIGNAL_WEIGHTS = {
  shortPrompt: 0.20,
  simpleKeyword: 0.15,
  complexKeyword: -0.30,
  highContextPenalty: -0.25,
  exploreAgent: 0.30,
  forkAgent: -0.15,
  codeReviewAgent: -0.20,
} as const

const SIMPLE_KEYWORDS = new Set([
  'find', 'search', 'list', 'read', 'check', 'verify', 'count', 'show',
  'look', 'grep', 'locate', 'scan', 'inspect', 'print', 'log', 'status',
  'rename', 'move', 'copy', 'delete', 'remove', 'add', 'update', 'fix',
  'typo', 'import', 'export', 'format', 'lint', 'test', 'run',
])

const COMPLEX_KEYWORDS = new Set([
  'design', 'architect', 'explain', 'why', 'debug', 'refactor', 'migrate',
  'optimize', 'performance', 'security', 'compare', 'analyze', 'strategy',
  'plan', 'review', 'evaluate', 'trade-off', 'tradeoff', 'complex',
  'implement', 'build', 'create', 'integrate', 'deploy', 'configure',
])

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export function classifySpawnTask(input: SpawnClassificationInput): {
  tier: ComplexityTier
  confidence: number
  signals: Record<string, number>
  reason: string
} {
  const config = _config
  const signals: Record<string, number> = {}
  let simplicityScore = 0

  // Signal 1: Sub-agent type bias
  if (input.subagentType === 'explore') {
    signals.exploreAgent = SIGNAL_WEIGHTS.exploreAgent
    simplicityScore += SIGNAL_WEIGHTS.exploreAgent
  } else if (input.subagentType === 'fork') {
    signals.forkAgent = SIGNAL_WEIGHTS.forkAgent
    simplicityScore += SIGNAL_WEIGHTS.forkAgent
  } else if (input.subagentType === 'code-reviewer') {
    signals.codeReviewAgent = SIGNAL_WEIGHTS.codeReviewAgent
    simplicityScore += SIGNAL_WEIGHTS.codeReviewAgent
  }

  // Signal 2: Prompt length
  const promptLen = input.prompt.trim().length
  if (promptLen < 100) {
    signals.shortPrompt = SIGNAL_WEIGHTS.shortPrompt
    simplicityScore += SIGNAL_WEIGHTS.shortPrompt
  } else if (promptLen > 500) {
    signals.longPrompt = -0.10
    simplicityScore -= 0.10
  }

  // Signal 3: Keyword analysis on task prompt
  const promptLower = input.prompt.toLowerCase()
  const words = promptLower.split(/\s+/)
  const hasSimple = words.some(w => SIMPLE_KEYWORDS.has(w))
  const hasComplex = words.some(w => COMPLEX_KEYWORDS.has(w))

  if (hasSimple && !hasComplex) {
    signals.simpleKeyword = SIGNAL_WEIGHTS.simpleKeyword
    simplicityScore += SIGNAL_WEIGHTS.simpleKeyword
  }
  if (hasComplex) {
    signals.complexKeyword = SIGNAL_WEIGHTS.complexKeyword
    simplicityScore += SIGNAL_WEIGHTS.complexKeyword
  }

  // Signal 4: High context penalty
  const defaultFloor = config.contextFloors.default?.maxEffectiveContext ?? 30000
  if (input.contextTokens > defaultFloor) {
    signals.highContextPenalty = SIGNAL_WEIGHTS.highContextPenalty
    simplicityScore += SIGNAL_WEIGHTS.highContextPenalty
  }

  // Signal 5: High-precision tool detected in sub-agent's tool set
  const hpTool = detectHighPrecisionTool(input.toolNames)
  if (hpTool) {
    signals.highPrecisionTool = -0.50
    simplicityScore -= 0.50
  }

  // Map score → tier and confidence
  let tier: ComplexityTier
  let confidence: number

  if (simplicityScore >= 0.35) {
    tier = 'simple'
    confidence = Math.min(1, 0.5 + simplicityScore)
  } else if (simplicityScore >= 0.0) {
    tier = 'moderate'
    confidence = 0.5 + Math.abs(simplicityScore)
  } else {
    tier = 'complex'
    confidence = Math.min(1, 0.5 + Math.abs(simplicityScore))
  }

  const activeSignals = Object.entries(signals)
    .filter(([, v]) => v !== 0)
    .map(([k]) => k)
    .join(' + ')

  return {
    tier,
    confidence,
    signals,
    reason: activeSignals || 'no_signals_baseline',
  }
}

// ---------------------------------------------------------------------------
// High-precision tool detection
// ---------------------------------------------------------------------------

function detectHighPrecisionTool(toolNames?: string[]): string | undefined {
  if (!toolNames || toolNames.length === 0) return undefined
  const config = _config
  for (const name of toolNames) {
    if (config.highPrecisionTools.includes(name)) return name
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

export interface ModelRouterOptions {
  ceilingModel: string
  availableModels: ModelTierMap
}

/**
 * Select the best model for a sub-agent spawn. Pure function — no side
 * effects, no network calls, <1ms execution.
 */
export function selectModelForSpawn(
  input: SpawnClassificationInput,
  options: ModelRouterOptions,
): RoutingDecision {
  const config = _config
  const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const classification = classifySpawnTask(input)
  const hpTool = detectHighPrecisionTool(input.toolNames)

  // High-precision tools always force at least standard tier
  if (hpTool) {
    const model = resolveAtLeastStandard(options)
    return {
      spawnId,
      subagentType: input.subagentType,
      signals: classification.signals,
      confidence: classification.confidence,
      classifiedTier: 'complex',
      selectedModel: model,
      reason: `high_precision_tool:${hpTool}`,
      contextTokens: input.contextTokens,
      highPrecisionToolDetected: hpTool,
      fallbackTriggered: false,
    }
  }

  // Context-based floor: exclude models whose effective context is exceeded
  const candidateModel = tierToModel(classification.tier, options)
  const candidateFloor = config.contextFloors[candidateModel]?.maxEffectiveContext
    ?? config.contextFloors.default?.maxEffectiveContext
    ?? 30000

  if (input.contextTokens > candidateFloor) {
    const model = resolveAtLeastStandard(options)
    return {
      spawnId,
      subagentType: input.subagentType,
      signals: classification.signals,
      confidence: classification.confidence,
      classifiedTier: classification.tier,
      selectedModel: model,
      reason: `context_floor_exceeded:${input.contextTokens}>${candidateFloor}`,
      contextTokens: input.contextTokens,
      fallbackTriggered: false,
    }
  }

  // Confidence gate: only downgrade on high confidence
  if (classification.confidence < config.confidence.highThreshold && classification.tier === 'simple') {
    return {
      spawnId,
      subagentType: input.subagentType,
      signals: classification.signals,
      confidence: classification.confidence,
      classifiedTier: classification.tier,
      selectedModel: options.availableModels.standard,
      reason: `low_confidence_fallback:${classification.confidence.toFixed(2)}`,
      contextTokens: input.contextTokens,
      fallbackTriggered: false,
    }
  }

  const model = tierToModel(classification.tier, options)
  return {
    spawnId,
    subagentType: input.subagentType,
    signals: classification.signals,
    confidence: classification.confidence,
    classifiedTier: classification.tier,
    selectedModel: model,
    reason: classification.reason,
    contextTokens: input.contextTokens,
    fallbackTriggered: false,
  }
}

function tierToModel(tier: ComplexityTier, options: ModelRouterOptions): string {
  switch (tier) {
    case 'simple': return options.availableModels.economy
    case 'moderate': return options.availableModels.standard
    case 'complex': return options.ceilingModel
  }
}

function resolveAtLeastStandard(options: ModelRouterOptions): string {
  const standardTier = getModelTier(options.availableModels.standard)
  if (standardTier === 'economy') return options.ceilingModel
  return options.availableModels.standard
}

// ---------------------------------------------------------------------------
// Fallback escalation (for spawn-time retry)
// ---------------------------------------------------------------------------

/**
 * Given a failed routing decision, produce the escalated model for retry.
 * Returns null if no further escalation is possible (already at ceiling).
 */
export function escalateModel(
  decision: RoutingDecision,
  options: ModelRouterOptions,
  reason: string,
): RoutingDecision | null {
  const current = decision.selectedModel

  let escalatedModel: string | null = null

  if (current === options.availableModels.economy) {
    escalatedModel = options.availableModels.standard
  } else if (current === options.availableModels.standard && current !== options.ceilingModel) {
    escalatedModel = options.ceilingModel
  }

  if (!escalatedModel || escalatedModel === current) return null

  return {
    ...decision,
    selectedModel: escalatedModel,
    fallbackTriggered: true,
    fallbackReason: reason,
    escalatedFrom: current,
  }
}

// ---------------------------------------------------------------------------
// Default model tier map builder
// ---------------------------------------------------------------------------

/**
 * Cross-provider tier map used by Auto mode. Picks the globally cheapest
 * model per complexity tier regardless of provider:
 *   simple   -> GPT-5.4 Nano  ($0.20/$1.25 per MTok)
 *   moderate -> Claude Haiku   ($0.80/$4.00 per MTok)
 *   complex  -> Claude Sonnet  ($3.00/$15.00 per MTok)
 */
export function buildAutoTierMap(): ModelTierMap {
  return {
    economy: 'gpt-5.4-nano',
    standard: 'claude-haiku-4-5-20251001',
    premium: 'claude-sonnet-4-6',
  }
}

/**
 * Build a ModelTierMap from the catalog. Picks the best current-generation
 * model for each tier within the same provider family as the ceiling model.
 */
export function buildModelTierMap(ceilingModelId: string): ModelTierMap {
  const ceilingEntry = getModelEntry(ceilingModelId)
  const provider = ceilingEntry?.provider ?? 'anthropic'

  if (provider === 'anthropic') {
    return {
      economy: 'claude-haiku-4-5-20251001',
      standard: 'claude-sonnet-4-6',
      premium: ceilingModelId,
    }
  }

  if (provider === 'openai') {
    return {
      economy: 'gpt-5.4-mini',
      standard: 'gpt-5-mini',
      premium: ceilingModelId,
    }
  }

  // Fallback: use ceiling for everything (no routing benefit, safe)
  return {
    economy: ceilingModelId,
    standard: ceilingModelId,
    premium: ceilingModelId,
  }
}
