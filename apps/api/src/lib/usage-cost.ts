// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Usage Cost Calculator
 *
 * Computes USD usage cost from LLM/image/voice/social usage using raw provider
 * costs plus a flat MARKUP_MULTIPLIER (Cursor-style pricing).
 *
 * `rawUsd` is the provider list-price cost; `billedUsd` is what we charge the
 * workspace. There are no per-call minimums.
 *
 * Model costs (per 1M tokens) come from `@shogo/model-catalog` MODEL_DOLLAR_COSTS.
 */

import {
  getModelTier as catalogGetModelTier,
  getModelBillingModel,
  getModelEntry,
  resolveAgentModeDefault,
  MODEL_DOLLAR_COSTS,
  calculateDollarCost,
  type ModelTier,
  type AgentMode,
  type BillingModel,
} from '@shogo/model-catalog'
import { getDbModelBillingModel, getDbModelPricing } from './db-model-pricing'
import { estimateTripoCredits, type TripoOp } from './tripo-3d'

export type { ModelTier, AgentMode }
export { MODEL_DOLLAR_COSTS, calculateDollarCost }

/** Flat markup applied to all raw provider costs (LLM, voice, images). */
export const MARKUP_MULTIPLIER = 1.20

export type ModelName = BillingModel

/** Re-export from the shared catalog for backward compatibility. */
export const getModelTier = catalogGetModelTier

/**
 * Map agent mode (model ID or legacy "basic"/"advanced") to billing model name.
 */
export function agentModeToModel(agentMode?: string): ModelName {
  if (!agentMode) return resolveAgentModeDefault('advanced') as ModelName
  if (agentMode === 'basic' || agentMode === 'advanced') {
    return resolveAgentModeDefault(agentMode as AgentMode) as ModelName
  }
  return modelIdToBillingModel(agentMode)
}

/**
 * Static catalog first, then DB/cloud models (addressed by UUID), then the
 * `sonnet` fallback.
 */
function modelIdToBillingModel(id: string): ModelName {
  const billing = getModelEntry(id) ? getModelBillingModel(id) : getDbModelBillingModel(id)
  if (billing && billing in MODEL_DOLLAR_COSTS) return billing as ModelName
  return 'sonnet'
}

/**
 * Map a proxy model string to a billing ModelName using the shared catalog.
 */
export function proxyModelToBillingModel(proxyModel: string): ModelName {
  return modelIdToBillingModel(proxyModel)
}

function resolveModel(modelOrAgentMode?: string): ModelName {
  if (!modelOrAgentMode) return 'sonnet'
  if (modelOrAgentMode === 'basic' || modelOrAgentMode === 'advanced') {
    return agentModeToModel(modelOrAgentMode)
  }
  if (modelOrAgentMode in MODEL_DOLLAR_COSTS) {
    return modelOrAgentMode as ModelName
  }
  return modelIdToBillingModel(modelOrAgentMode)
}

export interface UsageCostResult {
  /** Raw provider cost in USD (no markup). */
  rawUsd: number
  /** Marked-up cost charged to the workspace in USD. */
  billedUsd: number
}

/**
 * Calculate USD cost from separate input/output token counts.
 *
 * `inputTokens` should be non-cached input only. Pass `cachedInputTokens`
 * separately so they're billed at the discounted cache-read rate. Pass
 * `cacheWriteTokens` separately so they're billed at the cache-write rate.
 */
export function calculateUsageCost(
  inputTokens: number,
  outputTokens: number,
  modelOrAgentMode?: string,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
): UsageCostResult {
  // DB-defined models (including custom providers) carry their own per-token
  // pricing. Prefer it over the static bucket so admin-added models bill at
  // their configured rates. (Agent-mode aliases fall through to the bucket
  // logic below.)
  if (modelOrAgentMode) {
    const dbPricing = getDbModelPricing(modelOrAgentMode)
    if (dbPricing) {
      const dbRawUsd =
        (inputTokens * dbPricing.inputPerMillion / 1_000_000) +
        (cacheWriteTokens * dbPricing.cacheWritePerMillion / 1_000_000) +
        (cachedInputTokens * dbPricing.cachedInputPerMillion / 1_000_000) +
        (outputTokens * dbPricing.outputPerMillion / 1_000_000)
      if (dbRawUsd === 0) return { rawUsd: 0, billedUsd: 0 }
      return { rawUsd: dbRawUsd, billedUsd: dbRawUsd * MARKUP_MULTIPLIER }
    }
  }

  const model = resolveModel(modelOrAgentMode)
  const costs = MODEL_DOLLAR_COSTS[model]
  const rawUsd =
    (inputTokens * costs.inputPerMillion / 1_000_000) +
    (cacheWriteTokens * costs.cacheWritePerMillion / 1_000_000) +
    (cachedInputTokens * costs.cachedInputPerMillion / 1_000_000) +
    (outputTokens * costs.outputPerMillion / 1_000_000)

  if (rawUsd === 0) return { rawUsd: 0, billedUsd: 0 }
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// Image Generation Usage Costs
// =============================================================================

/**
 * Raw provider costs per image in USD (approximate list price).
 * Derived from previous credit-based config at $0.10/credit.
 */
export const IMAGE_USD_CONFIG: Record<string, { base: number; hdMultiplier: number; largeSizeMultiplier: number }> = {
  'dall-e-3':       { base: 0.26, hdMultiplier: 2.0, largeSizeMultiplier: 1.5 },
  'dall-e-2':       { base: 0.13, hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'gpt-image-1':    { base: 0.39, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'gpt-image-1.5':  { base: 0.39, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'gpt-image-2':    { base: 0.39, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'gpt-image-2.5-flare': { base: 0.39, hdMultiplier: 1.5, largeSizeMultiplier: 1.5 },
  'imagen-4':       { base: 0.20, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-ultra': { base: 0.39, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  'imagen-4-fast':  { base: 0.13, hdMultiplier: 1.0, largeSizeMultiplier: 1.5 },
  // fal list prices (fal.ai model pages, 2026-10). "hd" maps to 2K output for
  // Nano Banana (same price as 1K) and QUALITY rendering for Ideogram.
  'nano-banana-pro': { base: 0.15,   hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'nano-banana-2':   { base: 0.08,   hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'seedream-5-pro':  { base: 0.0675, hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'flux-pro-ultra':  { base: 0.06,   hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
  'ideogram-3':      { base: 0.06,   hdMultiplier: 1.5, largeSizeMultiplier: 1.0 },
  'recraft-3':       { base: 0.04,   hdMultiplier: 1.0, largeSizeMultiplier: 1.0 },
}

const LARGE_IMAGE_SIZES = new Set(['1792x1024', '1024x1792', '1536x1024', '1024x1536'])

/**
 * Calculate USD cost for image generation (flat per-image, not token-based).
 */
export function calculateImageUsageCost(
  model: string,
  quality: string = 'standard',
  size: string = '1024x1024',
): UsageCostResult {
  // dall-e-3 (the old fallback) is retired (OpenAI, 2026-09) — fall back to
  // the current gpt-image-1 pricing profile for an unrecognized model id.
  const config = IMAGE_USD_CONFIG[model] || IMAGE_USD_CONFIG['gpt-image-1']
  let rawUsd = config.base

  if (quality === 'hd' || quality === 'high') {
    rawUsd *= config.hdMultiplier
  }

  if (LARGE_IMAGE_SIZES.has(size)) {
    rawUsd *= config.largeSizeMultiplier
  }

  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// Image utility costs (upscale, background removal)
// =============================================================================

/** fal list prices: Clarity upscaler bills per output megapixel; BiRefNet per compute second (flat estimate). */
export const IMAGE_PROCESS_USD_CONFIG = {
  upscale: { perOutputMegapixel: 0.03, minUsd: 0.03 },
  'remove-background': { flat: 0.005 },
} as const

export function calculateImageProcessUsageCost(
  operation: keyof typeof IMAGE_PROCESS_USD_CONFIG,
  output: { width?: number; height?: number } = {},
): UsageCostResult {
  let rawUsd: number
  if (operation === 'upscale') {
    const cfg = IMAGE_PROCESS_USD_CONFIG.upscale
    const megapixels = output.width && output.height ? (output.width * output.height) / 1_000_000 : 4
    rawUsd = Math.max(cfg.minUsd, megapixels * cfg.perOutputMegapixel)
  } else {
    rawUsd = IMAGE_PROCESS_USD_CONFIG['remove-background'].flat
  }
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// Video Generation Usage Costs
// =============================================================================

/** Per-second list prices, as carried by a `VIDEO_MODEL_CATALOG` entry. */
export interface VideoRates {
  usdPerSecond: number
  usdPerSecondWithAudio?: number
}

/**
 * USD for one generated video: the model's per-second list price (the audio
 * rate when audio is on and the model prices it separately) times duration.
 */
export function calculateVideoUsageCost(rates: VideoRates, seconds: number, audio = false): UsageCostResult {
  const perSecond = audio && rates.usdPerSecondWithAudio !== undefined ? rates.usdPerSecondWithAudio : rates.usdPerSecond
  const rawUsd = Math.max(0, seconds) * perSecond
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// 3D Generation Usage Costs (Tripo3D)
// =============================================================================

/** Tripo bills in credits; 100 credits = $1.00. */
export const TRIPO_USD_PER_CREDIT = 0.01

/**
 * Advisory estimate for the `estimated_usd` on the queued response, priced
 * from the operation registry's credit table (`TRIPO_OPS`). Billing is never
 * driven by this: the status route charges the task's own `credits_consumed`.
 */
export function estimateTripoTaskCost(params: {
  op: TripoOp
  model?: string
  texture?: boolean
  textureQuality?: string
  animations?: string[]
  animation?: string
  [opParam: string]: unknown
}): UsageCostResult {
  const { op, textureQuality, animations, animation, ...rest } = params
  const credits = estimateTripoCredits(op, {
    ...rest,
    ...(textureQuality !== undefined ? { texture_quality: textureQuality } : {}),
    ...(animations !== undefined ? { animations } : {}),
    ...(animation !== undefined ? { animation } : {}),
  })
  const rawUsd = credits * TRIPO_USD_PER_CREDIT
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

/**
 * USD for a finished Tripo task, from the credits Tripo reports consuming.
 * Never estimate what the task itself can tell us.
 */
export function calculate3dUsageCost(creditsConsumed: number): UsageCostResult {
  const rawUsd = Math.max(0, creditsConsumed) * TRIPO_USD_PER_CREDIT
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// Social lookup usage costs (EnsembleData)
// =============================================================================

/**
 * EnsembleData list price per request unit, in USD.
 * Confirm against the current EnsembleData plan. 0.0025 is a placeholder.
 */
export const SOCIAL_LOOKUP_USD_PER_UNIT = 0.0025

export type SocialLookupPlatform = 'instagram' | 'tiktok'
export type SocialLookupOp = 'profile' | 'posts'

/**
 * Estimated EnsembleData units for one agent lookup.
 *
 * Must stay aligned with `ensembledata-provider.ts`: a profile is one
 * request. Recent posts page ~10 items per request (`depth`). TikTok posts
 * are one request at that depth. Instagram posts also resolve the profile,
 * then fetch the posts feed and the reels feed.
 */
export function socialLookupUnits(
  platform: SocialLookupPlatform,
  op: SocialLookupOp,
  limit: number,
): number {
  if (op === 'profile') return 1
  const depth = Math.max(1, Math.ceil(limit / 10))
  return platform === 'tiktok' ? depth : 1 + 2 * depth
}

export function calculateSocialLookupCost(units: number): UsageCostResult {
  const rawUsd = units * SOCIAL_LOOKUP_USD_PER_UNIT
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

// =============================================================================
// Audio Transcription Usage Costs
// =============================================================================

/** OpenAI Whisper API list price: $0.006 per minute of audio, billed per second. */
const WHISPER_USD_PER_SECOND = 0.006 / 60

/**
 * Calculate USD cost for a Whisper transcription call from the audio
 * duration (seconds) reported by the API response. Falls back to a
 * one-second minimum when duration is unavailable (e.g. non-JSON
 * `response_format`) so a call is never billed at exactly $0.
 */
export function calculateTranscriptionUsageCost(durationSeconds: number | undefined): UsageCostResult {
  const seconds = durationSeconds && durationSeconds > 0 ? durationSeconds : 1
  const rawUsd = seconds * WHISPER_USD_PER_SECOND
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}
