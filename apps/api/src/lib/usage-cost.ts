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

/**
 * The Shogo fee as a percentage of the model cost, derived from the markup so
 * the UI never hard-codes "20%". `1.20` → `20`.
 */
export const SHOGO_FEE_PERCENT = Math.round((MARKUP_MULTIPLIER - 1) * 100)

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
  /**
   * The model the cost was actually priced as: the canonical model id when a
   * DB or static-catalog entry supplied the rates, otherwise the static billing
   * bucket (`opus`/`sonnet`/`haiku`). Recorded as `actionMetadata.billingModel`
   * so a DB-priced model (e.g. `hoshi-2-0`) is not labelled by its bucket.
   */
  pricedAs?: string
}

/**
 * Split one usage row into the two lines the UI shows: the provider's model
 * cost and the Shogo fee on top of it.
 *
 * `modelCostUsd + shogoFeeUsd + unitemizedUsd` always equals the row's
 * effective cost (`billedUsd` when set, else the recorded provider cost), so
 * the totals a user already sees do not change.
 *
 * - `billed > 0` and a provider cost is known → model = min(raw, billed),
 *   fee = billed − model (clamped at 0 when raw > billed).
 * - `billed > 0` and no provider cost anywhere → the whole amount is
 *   `unitemizedUsd` (rows from before the credits→USD migration, 2026-04-24).
 *   No guessing, no backfill.
 * - `billed == 0` → model = the recorded provider cost, fee = 0 (desktop,
 *   internal and free rows).
 */
export interface UsageCostSplit {
  modelCostUsd: number
  shogoFeeUsd: number
  unitemizedUsd: number
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function splitUsageCost(row: {
  billedUsd?: number | null
  rawUsd?: number | null
  actionMetadata?: unknown
}): UsageCostSplit {
  const billed = finiteOrNull(row.billedUsd) ?? 0
  const meta = (() => {
    const raw = row.actionMetadata
    if (!raw) return {} as Record<string, unknown>
    if (typeof raw === 'object') return raw as Record<string, unknown>
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} as Record<string, unknown> }
    }
    return {} as Record<string, unknown>
  })()
  const metaRaw = finiteOrNull(meta.rawUsd) ?? finiteOrNull(meta.dollarCost)
  // `??`, not `||`: a recorded 0 is a real provider cost, not "unknown".
  const raw = finiteOrNull(row.rawUsd) ?? metaRaw

  if (billed > 0) {
    if (raw === null) return { modelCostUsd: 0, shogoFeeUsd: 0, unitemizedUsd: billed }
    const modelCostUsd = Math.min(raw, billed)
    return { modelCostUsd, shogoFeeUsd: billed - modelCostUsd, unitemizedUsd: 0 }
  }

  // No billed amount: the row's cost is the provider cost, and there is no fee.
  // Mirrors the effective-cost rule (`raw > 0 ? raw : metaRaw`) so the split
  // still adds up to the total when `rawUsd` is a recorded 0 but meta has money.
  const modelCostUsd = (raw ?? 0) > 0 ? (raw as number) : (metaRaw ?? 0)
  return { modelCostUsd, shogoFeeUsd: 0, unitemizedUsd: 0 }
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
      if (dbRawUsd === 0) return { rawUsd: 0, billedUsd: 0, pricedAs: modelOrAgentMode }
      return { rawUsd: dbRawUsd, billedUsd: dbRawUsd * MARKUP_MULTIPLIER, pricedAs: modelOrAgentMode }
    }
  }
  if (!hasKnownUsagePricing(modelOrAgentMode)) {
    return { rawUsd: 0, billedUsd: 0, pricingUnknown: true, pricedAs: resolveModel(modelOrAgentMode) }
  }

  const model = resolveModel(modelOrAgentMode)
  const costs = MODEL_DOLLAR_COSTS[model]
  const rawUsd =
    (inputTokens * costs.inputPerMillion / 1_000_000) +
    (cacheWriteTokens * costs.cacheWritePerMillion / 1_000_000) +
    (cachedInputTokens * costs.cachedInputPerMillion / 1_000_000) +
    (outputTokens * costs.outputPerMillion / 1_000_000)

  // A static-catalog model is priced as itself; an agent-mode alias or an
  // unknown id is priced as its bucket, so that is what gets recorded.
  const pricedAs = modelOrAgentMode && getModelEntry(modelOrAgentMode)
    ? modelOrAgentMode
    : model

  if (rawUsd === 0) return { rawUsd: 0, billedUsd: 0, pricedAs }
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER, pricedAs }
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
// Video Generation Usage Costs
// =============================================================================

/** Marked-up charge for a raw upstream amount; every media kind marks up the same way. */
export function calculateMarkedUpUsageCost(rawUsd: number): UsageCostResult {
  const raw = Math.max(0, rawUsd)
  return { rawUsd: raw, billedUsd: raw * MARKUP_MULTIPLIER }
}

/**
 * USD for a Higgsfield request: the free `/estimate` captured at submit time,
 * marked up exactly like every other media charge. Never used for a request
 * that ended `failed`, `nsfw` or `canceled` — those are refunded upstream, so
 * billing them would overcharge.
 */
export function calculateHiggsfieldUsageCost(estimate: { rawUsd: number }): UsageCostResult {
  return calculateMarkedUpUsageCost(estimate.rawUsd)
}

/**
 * USD for one Lyria song. Google bills music generation flat per song (there is
 * no token meter and no free tier), so the catalog's `usdPerRequest` is the
 * whole cost — marked up like every other media charge.
 */
export function calculateMusicUsageCost(usdPerSong: number): UsageCostResult {
  const rawUsd = Math.max(0, usdPerSong)
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

/**
 * Google Omni token rates, USD per million tokens
 * (ai.google.dev/gemini-api/docs/pricing, Nov 2026): $1.50 input (text, image,
 * and the previous turn's video on an edit), $12 video output, $9 text and
 * thinking output. An Omni turn is billed from the tokens the interaction
 * reports, so this table plus {@link calculateGoogleVideoUsageCost} is the whole
 * price of a clip — including the parent clip's input tokens a follow-up turn
 * pays for again.
 */
export const GOOGLE_VIDEO_TOKEN_USD = {
  inputPerMillion: 1.5,
  videoOutputPerMillion: 12,
  textOutputPerMillion: 9,
} as const

/** The shape `readOmniUsage` hands over (a subset of Google's `usage` object). */
export interface GoogleVideoUsage {
  total_input_tokens?: number
  total_output_tokens?: number
  total_thought_tokens?: number
  output_tokens_by_modality?: Record<string, number>
}

/**
 * USD for one finished Omni turn, from its own usage tokens, marked up like
 * every other media charge.
 *
 * Without a modality split every output token is billed at the video rate: that
 * is the only safe direction, because undercounting output would underbill a
 * video we did deliver. Thinking tokens are billed at the text rate.
 */
export function calculateGoogleVideoUsageCost(usage: GoogleVideoUsage): UsageCostResult {
  const input = Math.max(0, usage.total_input_tokens ?? 0)
  const thought = Math.max(0, usage.total_thought_tokens ?? 0)
  const byModality = usage.output_tokens_by_modality ?? {}

  let videoOutput = 0
  let otherOutput = 0
  const modalities = Object.keys(byModality)
  if (modalities.length > 0) {
    for (const modality of modalities) {
      const tokens = Math.max(0, byModality[modality] ?? 0)
      if (/video/i.test(modality)) videoOutput += tokens
      else otherOutput += tokens
    }
  } else {
    videoOutput = Math.max(0, usage.total_output_tokens ?? 0)
  }

  const rawUsd =
    (input * GOOGLE_VIDEO_TOKEN_USD.inputPerMillion +
      videoOutput * GOOGLE_VIDEO_TOKEN_USD.videoOutputPerMillion +
      (otherOutput + thought) * GOOGLE_VIDEO_TOKEN_USD.textOutputPerMillion) /
    1_000_000

  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}

/**
 * Video output tokens Google bills per second of clip, by resolution tier
 * (ai.google.dev/gemini-api/docs/pricing, Nov 2026). These are the numbers the
 * catalog's per-second rates are converted from, and the ones a follow-up turn
 * pays again as *input* when it re-reads the parent clip.
 */
export const GOOGLE_VIDEO_TOKENS_PER_SECOND: Record<string, number> = {
  '360p': 1_931,
  '720p': 5_792,
  '1080p': 8_688,
  '4k': 17_376,
}

/** The parent clip's input tokens, at the cheaper input rate. `0` when unknown. */
export function googleVideoInputAllowanceUsd(resolution: string | undefined, seconds: number): number {
  const tokensPerSecond = resolution ? GOOGLE_VIDEO_TOKENS_PER_SECOND[resolution] : undefined
  if (!tokensPerSecond || !Number.isFinite(seconds) || seconds <= 0) return 0
  return (tokensPerSecond * seconds * GOOGLE_VIDEO_TOKEN_USD.inputPerMillion) / 1_000_000
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
 * LiveKit Inference STT list prices, per second of audio. Deepgram Nova-3 runs
 * $0.0058/min in multi-language mode (what we use) and $0.0048/min mono; the
 * published list covers the other flavours we might be pointed at, and anything
 * unrecognised falls back to the multi rate rather than to Whisper's.
 */
const LIVEKIT_STT_USD_PER_SECOND: Record<string, number> = {
  'deepgram/nova-3': 0.0058 / 60,
  'deepgram/nova-3-mono': 0.0048 / 60,
  'deepgram/nova-2': 0.0058 / 60,
}
const LIVEKIT_STT_DEFAULT_USD_PER_SECOND = 0.0058 / 60

/** `${rate}` for a `livekit/<provider>/<model>` id, matching the Inference model string. */
function livekitSttRate(model: string): number {
  const id = model.replace(/^livekit\//, '')
  return LIVEKIT_STT_USD_PER_SECOND[id] ?? LIVEKIT_STT_DEFAULT_USD_PER_SECOND
}

/**
 * Calculate USD cost for a transcription call from the audio duration
 * (seconds) reported by the API response. Falls back to a one-second minimum
 * when duration is unavailable (e.g. non-JSON `response_format`) so a call is
 * never billed at exactly $0. Pass the model id to price LiveKit Inference STT
 * (`livekit/deepgram/nova-3`); anything else bills at Whisper's rate.
 */
export function calculateTranscriptionUsageCost(
  durationSeconds: number | undefined,
  model?: string,
): UsageCostResult {
  const seconds = durationSeconds && durationSeconds > 0 ? durationSeconds : 1
  const perSecond = model?.startsWith('livekit/') ? livekitSttRate(model) : WHISPER_USD_PER_SECOND
  const rawUsd = seconds * perSecond
  return { rawUsd, billedUsd: rawUsd * MARKUP_MULTIPLIER }
}
