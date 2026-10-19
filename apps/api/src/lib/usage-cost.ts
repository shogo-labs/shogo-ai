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
  /**
   * Desktop has no real rates for the model (a cloud-only model whose catalog
   * entry carries no pricing, or one the catalog doesn't list). The cost is 0
   * rather than a guess; record `pricingUnknown: true` on the row so
   * `repriceLocalUsage` can fix it once rates arrive.
   */
  pricingUnknown?: true
}

/**
 * Desktop only: whether `model` has real per-token rates. Cloud keeps billing
 * unknown models at the `sonnet` bucket so usage is never free.
 */
export function hasKnownUsagePricing(model?: string): boolean {
  if (process.env.SHOGO_LOCAL_MODE !== 'true') return true
  if (!model || model === 'basic' || model === 'advanced') return true
  if (model in MODEL_DOLLAR_COSTS || getModelEntry(model)) return true
  return getDbModelPricing(model) !== undefined
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
  if (!hasKnownUsagePricing(modelOrAgentMode)) return { rawUsd: 0, billedUsd: 0, pricingUnknown: true }

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

export type ImageSizeClass = 'square' | 'portrait' | 'landscape'
export type ImageQuality = 'low' | 'medium' | 'high'
export type ImagePriceTable = Record<ImageSizeClass, Record<ImageQuality, number>>

/**
 * Raw provider cost per image in USD, per model × quality × size class.
 *
 * A single base + multipliers cannot express these ladders: GPT Image 1.5 is
 * 3.9× from medium to high, and non-square sizes are not a constant multiple
 * of square (GPT Image 2 low: $0.006 square, $0.005 landscape).
 */
export const IMAGE_USD_CONFIG: Record<string, { prices: ImagePriceTable }> = {
  // OpenAI, from the image-generation guide's cost tables ("Calculating
  // costs", read 2026-10-19). These are the real vendor prices; the previous
  // flat $0.39/$0.585 table advertised 7-11× the vendor price.
  'gpt-image-1': {
    prices: {
      square: { low: 0.011, medium: 0.042, high: 0.167 },
      portrait: { low: 0.016, medium: 0.063, high: 0.25 },
      landscape: { low: 0.016, medium: 0.063, high: 0.25 },
    },
  },
  'gpt-image-1.5': {
    prices: {
      square: { low: 0.009, medium: 0.034, high: 0.133 },
      portrait: { low: 0.013, medium: 0.05, high: 0.20 },
      landscape: { low: 0.013, medium: 0.05, high: 0.20 },
    },
  },
  'gpt-image-2': {
    prices: {
      square: { low: 0.006, medium: 0.053, high: 0.211 },
      portrait: { low: 0.005, medium: 0.041, high: 0.165 },
      landscape: { low: 0.005, medium: 0.041, high: 0.165 },
    },
  },
  // GPT Image 2.5 flare is billed per image-output token ($30/1M image output,
  // $8/1M image input), not per image. Low 1024² = 196 output tokens =
  // $0.00588 as read from the guide's calculator (2026-10-19). Its
  // medium/high token counts are not published anywhere we can read — the
  // calculator is client-side only — so those follow the GPT Image 2 row.
  // approximate — see https://platform.openai.com/docs/guides/image-generation#calculating-costs
  'gpt-image-2.5-flare': {
    prices: {
      square: { low: 0.00588, medium: 0.053, high: 0.211 },
      portrait: { low: 0.005, medium: 0.041, high: 0.165 },
      landscape: { low: 0.005, medium: 0.041, high: 0.165 },
    },
  },
  // Retired DALL·E ladders, kept in the same shape so old usage still bills.
  'dall-e-3': {
    prices: {
      square: { low: 0.26, medium: 0.26, high: 0.52 },
      portrait: { low: 0.39, medium: 0.39, high: 0.78 },
      landscape: { low: 0.39, medium: 0.39, high: 0.78 },
    },
  },
  'dall-e-2': {
    prices: {
      square: { low: 0.13, medium: 0.13, high: 0.13 },
      portrait: { low: 0.13, medium: 0.13, high: 0.13 },
      landscape: { low: 0.13, medium: 0.13, high: 0.13 },
    },
  },
  'imagen-4': {
    prices: {
      square: { low: 0.20, medium: 0.20, high: 0.20 },
      portrait: { low: 0.30, medium: 0.30, high: 0.30 },
      landscape: { low: 0.30, medium: 0.30, high: 0.30 },
    },
  },
  'imagen-4-ultra': {
    prices: {
      square: { low: 0.39, medium: 0.39, high: 0.39 },
      portrait: { low: 0.585, medium: 0.585, high: 0.585 },
      landscape: { low: 0.585, medium: 0.585, high: 0.585 },
    },
  },
  'imagen-4-fast': {
    prices: {
      square: { low: 0.13, medium: 0.13, high: 0.13 },
      portrait: { low: 0.195, medium: 0.195, high: 0.195 },
      landscape: { low: 0.195, medium: 0.195, high: 0.195 },
    },
  },
  // fal list prices (fal.ai model pages, 2026-10). "hd" maps to 2K output for
  // Nano Banana (same price as 1K) and QUALITY rendering for Ideogram.
  'nano-banana-pro': {
    prices: {
      square: { low: 0.15, medium: 0.15, high: 0.15 },
      portrait: { low: 0.15, medium: 0.15, high: 0.15 },
      landscape: { low: 0.15, medium: 0.15, high: 0.15 },
    },
  },
  'nano-banana-2': {
    prices: {
      square: { low: 0.08, medium: 0.08, high: 0.08 },
      portrait: { low: 0.08, medium: 0.08, high: 0.08 },
      landscape: { low: 0.08, medium: 0.08, high: 0.08 },
    },
  },
  'seedream-5-pro': {
    prices: {
      square: { low: 0.0675, medium: 0.0675, high: 0.0675 },
      portrait: { low: 0.0675, medium: 0.0675, high: 0.0675 },
      landscape: { low: 0.0675, medium: 0.0675, high: 0.0675 },
    },
  },
  'flux-pro-ultra': {
    prices: {
      square: { low: 0.06, medium: 0.06, high: 0.06 },
      portrait: { low: 0.06, medium: 0.06, high: 0.06 },
      landscape: { low: 0.06, medium: 0.06, high: 0.06 },
    },
  },
  'ideogram-3': {
    prices: {
      square: { low: 0.06, medium: 0.06, high: 0.09 },
      portrait: { low: 0.06, medium: 0.06, high: 0.09 },
      landscape: { low: 0.06, medium: 0.06, high: 0.09 },
    },
  },
  'recraft-3': {
    prices: {
      square: { low: 0.04, medium: 0.04, high: 0.04 },
      portrait: { low: 0.04, medium: 0.04, high: 0.04 },
      landscape: { low: 0.04, medium: 0.04, high: 0.04 },
    },
  },
  // Higgsfield fallbacks, only for displaying a price when `/estimate` is
  // unavailable — a request that cannot be priced is refused, never billed from
  // these numbers. SOUL V2 is $0.004 at 720p and $0.006 at 1080p.
  'hf-soul-v2': {
    prices: {
      square: { low: 0.004, medium: 0.004, high: 0.006 },
      portrait: { low: 0.004, medium: 0.004, high: 0.006 },
      landscape: { low: 0.004, medium: 0.004, high: 0.006 },
    },
  },
}

/**
 * The tool vocabulary is dall-e-3's ("standard" | "hd"), but every current
 * model prices five tiers. `xhigh`/`max` (Marketing Studio flare/sunburst) are
 * priced as high.
 */
const IMAGE_QUALITY_CLASS: Record<string, ImageQuality> = {
  low: 'low',
  medium: 'medium',
  standard: 'medium',
  auto: 'medium',
  high: 'high',
  hd: 'high',
  xhigh: 'high',
  max: 'high',
}

/** 1024x1024 → square; taller than wide → portrait; wider than tall → landscape. */
export function imageSizeClass(size: string): ImageSizeClass {
  const [width, height] = size.split('x').map(Number)
  if (!width || !height || width === height) return 'square'
  return height > width ? 'portrait' : 'landscape'
}

export function imageQualityClass(quality?: string): ImageQuality {
  return IMAGE_QUALITY_CLASS[quality ?? ''] ?? 'medium'
}

/**
 * Calculate USD cost for image generation (flat per-image, not token-based).
 *
 * The quality vocabulary is normalized *here*, not only at the request edge:
 * `recordImageUsage` passes the raw tool quality (`standard`/`hd`) while OpenAI
 * receives the normalized one, so both have to land on the same ladder.
 */
export function calculateImageUsageCost(
  model: string,
  quality: string = 'standard',
  size: string = '1024x1024',
): UsageCostResult {
  // gpt-image-1 (the current default) prices an unrecognized model id, so a
  // model that has no ladder of its own is never free.
  const config = IMAGE_USD_CONFIG[model] || IMAGE_USD_CONFIG['gpt-image-1']
  const rawUsd = config.prices[imageSizeClass(size)][imageQualityClass(quality)]
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
  usdPerSecond?: number
  usdPerSecondWithAudio?: number
  /** Flat upstream price for one clip (per-request providers, e.g. Higgsfield). */
  usdPerRequest?: number
}

/**
 * USD for one generated video. Per-request priced providers (Higgsfield) charge
 * a flat clip price; per-second providers charge the model's rate (the audio
 * rate when audio is on and the model prices it separately) times duration.
 */
export function calculateVideoUsageCost(rates: VideoRates, seconds: number, audio = false): UsageCostResult {
  let rawUsd: number
  if (rates.usdPerRequest !== undefined) {
    rawUsd = Math.max(0, rates.usdPerRequest)
  } else {
    const perSecond = audio && rates.usdPerSecondWithAudio !== undefined ? rates.usdPerSecondWithAudio : rates.usdPerSecond ?? 0
    rawUsd = Math.max(0, seconds) * perSecond
  }
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

/**
 * USD for a Higgsfield request: the free `/estimate` captured at submit time,
 * marked up exactly like every other media charge. Never used for a request
 * that ended `failed`, `nsfw` or `canceled` — those are refunded upstream, so
 * billing them would overcharge.
 */
export function calculateHiggsfieldUsageCost(estimate: { rawUsd: number }): UsageCostResult {
  const rawUsd = Math.max(0, estimate.rawUsd)
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

/**
 * USD for a Genjutsu edit: the vendor's per-source-second rate for the chosen
 * resolution times the clip's length, marked up. Returns `null` when the model
 * has no rate for that resolution or the duration is unknown — callers must
 * then refuse the job, because running it unpriced means billing zero.
 */
export function calculateGenjutsuUsageCost(
  rates: Record<string, number> | undefined,
  resolution: string,
  seconds: number,
): UsageCostResult | null {
  const perSecond = rates?.[resolution]
  if (perSecond === undefined || !Number.isFinite(seconds) || seconds <= 0) return null
  const rawUsd = seconds * perSecond
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
