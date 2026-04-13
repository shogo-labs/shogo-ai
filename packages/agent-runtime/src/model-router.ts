// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Model Router — Intelligent Turn-Level Model Selection
 *
 * Classifies each agent turn's complexity and routes it to the cheapest
 * model capable of handling it. Uses pure heuristics (no LLM call),
 * runs synchronously in <1ms per turn, and includes automatic fallback
 * escalation when a cheaper model produces a bad output.
 */

import { getModelTier, getModelEntry, type ModelTier } from '@shogo/model-catalog'
import type { Message } from '@mariozechner/pi-ai'
import thresholdsJson from './routing-thresholds.json'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUTO_MODEL_ID = 'auto'

// ---------------------------------------------------------------------------
// Config (loaded from JSON, overridable at runtime)
// ---------------------------------------------------------------------------

export interface RoutingConfig {
  contextFloors: Record<string, { maxEffectiveContext: number }>
  highPrecisionTools: string[]
  destructiveExecPatterns: string[]
  confidence: { highThreshold: number; lowThreshold: number }
  escalation: { maxFallbackRetries: number; consecutiveFailuresForEscalation: number }
  correctivePatterns: string[]
}

let _config: RoutingConfig = thresholdsJson as RoutingConfig

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
  turnId: string
  signals: Record<string, number>
  confidence: number
  classifiedTier: ComplexityTier
  selectedModel: string
  reason: string
  contextTokens: number
  highPrecisionToolDetected?: string
  fallbackTriggered: boolean
  fallbackReason?: string
  escalatedTo?: string
}

export interface ClassificationInput {
  prompt: string
  history: Message[]
  pendingToolNames?: string[]
  pendingToolArgs?: Record<string, any>
  contextTokens: number
  isToolFollowUp: boolean
  iterationIndex: number
  consecutiveToolErrors: number
  previousTurnCorrective: boolean
}

export interface ModelTierMap {
  economy: string
  standard: string
  premium: string
}

// ---------------------------------------------------------------------------
// Signal weights
// ---------------------------------------------------------------------------

const SIGNAL_WEIGHTS = {
  toolFollowUp: 0.25,
  shortMessage: 0.15,
  midLoopIteration: 0.20,
  simpleKeyword: 0.15,
  complexKeyword: -0.30,
  highContextPenalty: -0.25,
  correctivePenalty: -0.40,
} as const

const SIMPLE_KEYWORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'rename', 'fix', 'typo',
  'add', 'remove', 'delete', 'run', 'test', 'import', 'update', 'change',
  'move', 'copy', 'done', 'next', 'continue', 'go', 'proceed',
])

const COMPLEX_KEYWORDS = new Set([
  'design', 'architect', 'explain', 'why', 'debug', 'refactor', 'migrate',
  'optimize', 'performance', 'security', 'compare', 'analyze', 'strategy',
  'plan', 'review', 'evaluate', 'trade-off', 'tradeoff', 'complex',
])

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export function classifyTurn(input: ClassificationInput): { tier: ComplexityTier; confidence: number; signals: Record<string, number>; reason: string } {
  const config = _config
  const signals: Record<string, number> = {}
  let simplicityScore = 0

  // Signal 1: Tool follow-up
  if (input.isToolFollowUp) {
    signals.toolFollowUp = SIGNAL_WEIGHTS.toolFollowUp
    simplicityScore += SIGNAL_WEIGHTS.toolFollowUp
  }

  // Signal 2: Short message
  const promptLen = input.prompt.trim().length
  if (promptLen < 50) {
    signals.shortMessage = SIGNAL_WEIGHTS.shortMessage
    simplicityScore += SIGNAL_WEIGHTS.shortMessage
  } else if (promptLen > 500) {
    signals.longMessage = -0.10
    simplicityScore -= 0.10
  }

  // Signal 3: Mid-loop iteration (not first turn)
  if (input.iterationIndex > 0) {
    signals.midLoopIteration = SIGNAL_WEIGHTS.midLoopIteration
    simplicityScore += SIGNAL_WEIGHTS.midLoopIteration
  }

  // Signal 4: Keyword analysis
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

  // Signal 5: High context penalty
  const defaultFloor = config.contextFloors.default?.maxEffectiveContext ?? 30000
  if (input.contextTokens > defaultFloor) {
    signals.highContextPenalty = SIGNAL_WEIGHTS.highContextPenalty
    simplicityScore += SIGNAL_WEIGHTS.highContextPenalty
  }

  // Signal 6: Corrective re-prompt
  if (input.previousTurnCorrective) {
    signals.correctivePenalty = SIGNAL_WEIGHTS.correctivePenalty
    simplicityScore += SIGNAL_WEIGHTS.correctivePenalty
  }

  // Signal 7: High-precision tool detected
  const hpTool = detectHighPrecisionTool(input.pendingToolNames, input.pendingToolArgs)
  if (hpTool) {
    signals.highPrecisionTool = -0.50
    simplicityScore -= 0.50
  }

  // Signal 8: Consecutive tool errors
  if (input.consecutiveToolErrors >= config.escalation.consecutiveFailuresForEscalation) {
    signals.consecutiveErrors = -0.50
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

function detectHighPrecisionTool(
  toolNames?: string[],
  toolArgs?: Record<string, any>,
): string | undefined {
  if (!toolNames || toolNames.length === 0) return undefined
  const config = _config

  for (const name of toolNames) {
    if (config.highPrecisionTools.includes(name)) {
      if (name === 'exec' && toolArgs) {
        const cmd = String(toolArgs.command || toolArgs.cmd || '').toLowerCase()
        const isDestructive = config.destructiveExecPatterns.some(p => cmd.includes(p))
        if (isDestructive) return `exec:${cmd.slice(0, 40)}`
        continue
      }
      return name
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Corrective re-prompt detection
// ---------------------------------------------------------------------------

export function isCorrectivePrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim()
  return _config.correctivePatterns.some(p => {
    if (lower === p) return true
    if (lower.startsWith(p + ' ') || lower.startsWith(p + ',') || lower.startsWith(p + '.')) return true
    return false
  })
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

export interface ModelRouterOptions {
  ceilingModel: string
  availableModels: ModelTierMap
}

/**
 * Select the best model for a turn. Returns the model ID to use.
 * Pure function — no side effects, no network calls, <1ms execution.
 */
export function selectModel(
  input: ClassificationInput,
  options: ModelRouterOptions,
): RoutingDecision {
  const config = _config
  const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const classification = classifyTurn(input)
  const hpTool = detectHighPrecisionTool(input.pendingToolNames, input.pendingToolArgs)

  // High-precision tools always force at least standard tier
  if (hpTool) {
    const model = resolveAtLeastStandard(options)
    return {
      turnId,
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
      turnId,
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
      turnId,
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
    turnId,
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
// Fallback escalation
// ---------------------------------------------------------------------------

/**
 * Given a failed routing decision, produce the escalated model.
 * Returns null if no further escalation is possible (already at ceiling).
 */
export function escalateModel(
  decision: RoutingDecision,
  options: ModelRouterOptions,
  reason: string,
): RoutingDecision | null {
  const config = _config
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
    escalatedTo: escalatedModel,
  }
}

// ---------------------------------------------------------------------------
// Default model tier map builder
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session-level routing state
// ---------------------------------------------------------------------------

export class RoutingState {
  consecutiveToolErrors = 0
  previousTurnCorrective = false
  fallbackRetriesThisTurn = 0
  lastDecision: RoutingDecision | null = null
  decisions: RoutingDecision[] = []

  recordToolSuccess(): void {
    this.consecutiveToolErrors = 0
  }

  recordToolError(): void {
    this.consecutiveToolErrors++
  }

  recordCorrectivePrompt(prompt: string): void {
    this.previousTurnCorrective = isCorrectivePrompt(prompt)
  }

  startNewTurn(): void {
    this.fallbackRetriesThisTurn = 0
  }

  canFallback(): boolean {
    return this.fallbackRetriesThisTurn < _config.escalation.maxFallbackRetries
  }

  recordFallback(): void {
    this.fallbackRetriesThisTurn++
  }

  recordDecision(decision: RoutingDecision): void {
    this.lastDecision = decision
    this.decisions.push(decision)
    if (this.decisions.length > 100) {
      this.decisions = this.decisions.slice(-50)
    }
  }
}
