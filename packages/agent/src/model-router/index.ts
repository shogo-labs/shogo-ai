// SPDX-License-Identifier: MIT
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

import { getModelTier, getModelEntry, getModelShortDisplayName, AUTO_MODEL_ID, type ModelTier } from '../model-catalog'
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

/**
 * A single Auto-tier override entry: the resolved model id plus an optional
 * provider hint. The hint is set when the id needs a provider that
 * `inferProviderFromModel` can't derive (e.g. a DB/custom-backed model such as
 * Hoshi resolved from the `hoshi-1.0` public alias).
 */
export interface AutoTierEntry {
  id: string
  provider?: string
}

/** Per-tier Auto override map, injected from admin config into the runtime. */
export type AutoTierOverride = Partial<Record<keyof ModelTierMap, AutoTierEntry>>

/** Extract just the model-id overrides for `buildAutoTierMap()`. */
export function autoTierIds(override?: AutoTierOverride): Partial<ModelTierMap> | undefined {
  if (!override) return undefined
  const ids: Partial<ModelTierMap> = {}
  if (override.economy?.id) ids.economy = override.economy.id
  if (override.standard?.id) ids.standard = override.standard.id
  if (override.premium?.id) ids.premium = override.premium.id
  return ids
}

/** Build a `modelId -> provider` hint lookup from an Auto override. */
export function autoTierProviderHints(override?: AutoTierOverride): Record<string, string> {
  const hints: Record<string, string> = {}
  if (!override) return hints
  for (const tier of ['economy', 'standard', 'premium'] as const) {
    const entry = override[tier]
    if (entry?.id && entry.provider) hints[entry.id] = entry.provider
  }
  return hints
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
  'commit', 'push', 'pull', 'install', 'create', 'open', 'close',
  'write', 'save', 'send', 'set', 'get', 'review', 'summarize',
])

const COMPLEX_KEYWORDS = new Set([
  'design', 'architect', 'explain', 'why', 'debug', 'refactor', 'migrate',
  'optimize', 'performance', 'security', 'compare', 'analyze', 'strategy',
  'evaluate', 'trade-off', 'tradeoff', 'complex',
  'implement', 'integrate', 'deploy', 'configure',
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
 *
 * An optional `override` (sourced from admin config injected into the runtime
 * env) replaces any tier whose value is a non-empty string. Unset/empty tiers
 * keep the hardcoded default, so a partial override is safe.
 */
export function buildAutoTierMap(override?: Partial<ModelTierMap>): ModelTierMap {
  const defaults: ModelTierMap = {
    economy: 'gpt-5.4-nano',
    standard: 'claude-haiku-4-5-20251001',
    premium: 'claude-sonnet-4-6',
  }
  if (!override) return defaults
  return {
    economy: override.economy?.trim() || defaults.economy,
    standard: override.standard?.trim() || defaults.standard,
    premium: override.premium?.trim() || defaults.premium,
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

// ---------------------------------------------------------------------------
// Human-readable routing log
// ---------------------------------------------------------------------------

const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  exploreAgent: 'explore-type agent',
  forkAgent: 'fork agent (complex)',
  codeReviewAgent: 'code review (needs precision)',
  shortPrompt: 'short prompt (<100 chars)',
  longPrompt: 'long prompt (>500 chars)',
  simpleKeyword: 'simple keywords (find, list, search...)',
  complexKeyword: 'complex keywords (design, refactor, analyze...)',
  highContextPenalty: 'large context window',
  highPrecisionTool: 'high-risk tool detected',
}

export function formatRoutingLog(decision: RoutingDecision, prompt: string): string {
  const model = getModelShortDisplayName(decision.selectedModel)
  const tier = decision.classifiedTier.toUpperCase()
  const conf = (decision.confidence * 100).toFixed(0)

  const triggers = Object.entries(decision.signals)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => {
      const desc = SIGNAL_DESCRIPTIONS[k] || k
      return `${v > 0 ? '+' : ''}${v.toFixed(2)} ${desc}`
    })

  const promptSnippet = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt
  const triggerList = triggers.length > 0
    ? triggers.join(', ')
    : 'no strong signals (baseline moderate)'

  let overrideNote = ''
  if (decision.reason.startsWith('high_precision_tool:')) {
    overrideNote = ` [OVERRIDE: ${decision.reason}]`
  } else if (decision.reason.startsWith('context_floor_exceeded:')) {
    overrideNote = ` [OVERRIDE: context too large for cheaper model]`
  } else if (decision.reason.startsWith('low_confidence_fallback:')) {
    overrideNote = ` [OVERRIDE: low confidence, using standard]`
  }

  return `[Auto] → ${model} (${tier}, ${conf}% confidence)${overrideNote} | triggers: ${triggerList} | prompt: "${promptSnippet}"`
}
