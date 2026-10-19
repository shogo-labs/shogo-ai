// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Single source of truth for LLM model IDs, display names, providers,
 * tiers, and aliases.
 *
 * Lifted into the SDK from `@shogo/model-catalog` (was AGPL) under MIT.
 * The original `@shogo/model-catalog` package is now a thin shim that
 * re-exports `@shogo-ai/sdk/model-catalog`, so existing consumers
 * continue to work without code changes.
 */

/** Special model ID that enables the intelligent model router. */
export const AUTO_MODEL_ID = 'auto' as const

export type Provider = 'anthropic' | 'openai' | 'google' | 'local' | 'openrouter' | 'custom'

/** Prefix used for OpenRouter model IDs in our catalog/allowlist. The ID
 * after the prefix is the canonical OpenRouter model id (e.g.
 * `openrouter:meta-llama/llama-3.1-405b-instruct`). The prefix lets
 * `inferProviderFromModel` route requests without colliding with native
 * Anthropic/OpenAI model names. */
export const OPENROUTER_MODEL_PREFIX = 'openrouter:' as const
export type ImageProvider = 'openai' | 'google' | 'local' | 'fal' | 'higgsfield'
export type VideoProvider = 'fal' | 'higgsfield'
export type ModelTier = 'economy' | 'standard' | 'premium'
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'gpt' | 'other'
export type ModelGeneration = 'current' | 'legacy'
export type ModelKind = 'chat' | 'live'
export type BillingModel =
  | 'gpt-5.4-nano' | 'haiku' | 'gpt-5.4-mini' | 'sonnet' | 'opus' | 'claude-fable-5-1'
  | 'gpt-6-astra' | 'gpt-6-sol' | 'gpt-6-luna' | 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna' | 'gpt-live-1'
  | 'claude-opus-5-5' | 'claude-haiku-5-5'
export type AgentMode = 'basic' | 'advanced'

/**
 * Empirical reliability of a model on a specific agent capability.
 *
 * - `reliable`: passes the relevant smoke eval consistently in CI.
 * - `flaky`: passes sometimes; admins should verify with their own
 *   workload before relying on it for the capability.
 * - `unsupported`: known to not work for this capability (e.g. tool
 *   calling absent, subagent tools never invoked).
 *
 * Models without a `capabilities` entry are simply unrated — the admin
 * UI treats unrated as "unknown, verify before relying on it".
 */
export type CapabilityReliability = 'reliable' | 'flaky' | 'unsupported'

export interface ModelCapabilities {
  /** Optional upstream protocol identity used for provider-specific routing. */
  upstream?: string
  /**
   * How reliably the model orchestrates subagents (`agent_spawn`,
   * `agent_create`, `agent_result`). Multi-agent flows like canvas
   * builds rely on the supervisor model spawning specialized children
   * and awaiting their results; small / older models often emit
   * `agent_spawn` calls without ever waiting on `agent_result`, leaving
   * the pipeline stuck. See the MiMo eval bucket-D analysis for the
   * specific failure mode.
   */
  subagentOrchestration?: CapabilityReliability
  /**
   * Whether this model accepts `input_audio` content blocks natively over
   * the OpenAI-compatible chat/completions wire format (as opposed to
   * requiring audio to be transcribed to text before it reaches the model).
   * Absent/`undefined` means "no native audio input" — callers should fall
   * back to Whisper transcription (see `transcribeAudioParts`).
   */
  supportsAudioInput?: boolean
}

/**
 * Reasoning / thinking effort applied when the model runs. Mirrors the
 * agent loop's `ThinkingLevel`. `xhigh` is the deepest budget; `off`
 * disables extended thinking. Admin-configurable per model and surfaced
 * (as a label) in the user picker.
 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ModelEntry {
  id: string
  provider: Provider
  apiModel: string
  displayName: string
  shortDisplayName: string
  tier: ModelTier
  family: ModelFamily
  generation: ModelGeneration
  /** `chat` models use the OpenAI-compatible LLM gateway; `live` models use a session transport. */
  kind?: ModelKind
  billingModel: BillingModel
  maxOutputTokens: number
  /** Provider charge in USD per minute for session-based models. */
  usdPerMinute?: number
  /**
   * Optional capability ratings — see `ModelCapabilities`. Absent for
   * unrated catalog entries and for dynamically-added OpenRouter
   * models (those don't go through this static catalog at all).
   */
  capabilities?: ModelCapabilities
  /** Admin-controlled position in the user-facing model picker. */
  sortOrder?: number
  /** Short blurb shown in the model picker info panel. */
  description?: string
  /** Total context window in tokens (distinct from `maxOutputTokens`). */
  contextWindow?: number
  /** Reasoning effort applied when this model runs (drives `thinkingLevel`). */
  reasoningEffort?: ReasoningEffort
  /**
   * Anthropic thinking API shape. `adaptive` models reject the legacy
   * budget-based `thinking.type: "enabled"` block with a 400. Required on
   * every Anthropic entry (enforced by thinking.test.ts) so a new model
   * can't ship without someone deciding it.
   */
  thinkingApi?: 'adaptive' | 'budget'
}

export interface ImageModelCapabilities {
  textToImage: boolean
  /** Accepts reference images (edits, character/style references). */
  imageToImage: boolean
  /** Most reference images one request accepts. 0 when `imageToImage` is false. */
  maxReferenceImages: number
}

export interface ImageModelEntry {
  id: string
  provider: ImageProvider
  apiModel: string
  displayName: string
  /** Endpoint for requests with reference images, when it differs from `apiModel` (fal). */
  editApiModel?: string
  capabilities: ImageModelCapabilities
  /** One line telling an agent when to pick this model. */
  bestFor?: string
  /** Retired upstream: kept so old ids still resolve and bill, hidden from model lists. */
  retired?: boolean
  /**
   * Still routable but superseded: dropped from the tool descriptions agents
   * read, still listed (flagged) by `list_media_models`. `replacement` names
   * the model to use instead.
   */
  deprecated?: boolean
  replacement?: string
  /**
   * Upstream list price for one generation, in USD, for providers that price
   * per request (Higgsfield). The exact amount billed is the `/estimate`
   * captured at submit time; this is the display fallback.
   */
  usdPerRequest?: number
}

export interface VideoModelEntry {
  id: string
  provider: VideoProvider
  displayName: string
  /** Text-to-video endpoint. */
  textToVideoApiModel: string
  /** Image-to-video endpoint (animates `start_image`). */
  imageToVideoApiModel?: string
  /** Durations in seconds the model accepts. Empty when the clip follows a source video. */
  durations: readonly number[]
  defaultDuration: number
  /** Aspect ratios the model takes as a parameter. Empty: output framing is fixed or follows the start image. */
  aspectRatios: readonly string[]
  /** Upstream list price per generated second, in USD (per-second priced providers). */
  usdPerSecond?: number
  /** Price per second when native audio is on. Absent when the model has no audio. */
  usdPerSecondWithAudio?: number
  /** Upstream list price for one clip, in USD (per-request priced providers: Higgsfield). */
  usdPerRequest?: number
  /**
   * Price per source second by resolution tier (Genjutsu). These workflows
   * quote no `usd` from `/estimate` — the vendor answers with a prose
   * description of the rate card — so the numbers here are the vendor's
   * published rates and the proxy bills `rate(resolution) × source seconds`.
   */
  usdPerSecondByResolution?: Record<string, number>
  /** Most reference images (character/object elements) one request accepts. */
  maxReferenceImages: number
  bestFor?: string
  /** Still routable but superseded — see `ImageModelEntry.deprecated`. */
  deprecated?: boolean
  replacement?: string
  /** Resolution tiers the model accepts (`480p` / `720p` / `1080p`). Empty when fixed. */
  resolutions?: readonly string[]
  defaultResolution?: string
  /** Takes a source video and edits it (Genjutsu workflows) instead of generating from scratch. */
  sourceVideo?: boolean
  /**
   * Genjutsu workflow this entry runs. `restyle` additionally requires a
   * `preset_id` from the restyle preset catalog.
   */
  genjutsu?: 'motion_transfer' | 'object_swap' | 'restyle'
  /** Minimum source-video duration in seconds (Genjutsu). */
  minSourceSeconds?: number
  /** Maximum source-video duration in seconds before the provider trims it (Genjutsu). */
  maxSourceSeconds?: number
  /** Minimum source pixels per frame (width × height), when the workflow requires it. */
  minSourcePixels?: number
  /** Maximum source-video size in bytes (Genjutsu restyle caps this at 200 MiB). */
  maxSourceBytes?: number
}

// ---------------------------------------------------------------------------
// Chat Model Catalog — single source of truth
// ---------------------------------------------------------------------------

export const MODEL_CATALOG = {
  // Anthropic — current generation
  'claude-opus-5-5': {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    apiModel: 'claude-opus-5-5',
    thinkingApi: 'adaptive',
    displayName: 'Claude Opus 5.5',
    shortDisplayName: 'Opus 5.5',
    tier: 'premium',
    family: 'opus',
    generation: 'current',
    // Dedicated bucket — 20% cheaper than Opus 5 on input/output and 60%
    // cheaper on cache reads (see MODEL_DOLLAR_COSTS['claude-opus-5-5']),
    // so it can't reuse the shared 'opus' bucket.
    billingModel: 'claude-opus-5-5',
    maxOutputTokens: 128_000,
    // Released 2026-09-22. Not yet run through the subagent-smoke eval —
    // unrated until verified (see `ModelCapabilities` doc comment above).
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-5',
    thinkingApi: 'adaptive',
    displayName: 'Claude Sonnet 5',
    shortDisplayName: 'Sonnet 5',
    tier: 'premium',
    family: 'sonnet',
    generation: 'current',
    billingModel: 'sonnet',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  'claude-fable-5-1': {
    id: 'claude-fable-5-1',
    provider: 'anthropic',
    apiModel: 'claude-fable-5-1',
    thinkingApi: 'adaptive',
    displayName: 'Claude Fable 5.1',
    shortDisplayName: 'Fable 5.1',
    tier: 'premium',
    family: 'fable',
    generation: 'current',
    billingModel: 'claude-fable-5-1',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  'claude-haiku-5-5': {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    apiModel: 'claude-haiku-5-5',
    thinkingApi: 'adaptive',
    displayName: 'Claude Haiku 5.5',
    shortDisplayName: 'Haiku 5.5',
    tier: 'economy',
    family: 'haiku',
    generation: 'current',
    // Dedicated bucket — 10x cheaper than the shared `haiku` bucket (Haiku 4.5
    // rates) and tiered above 100k input tokens, so it cannot reuse it.
    billingModel: 'claude-haiku-5-5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    // Released 2026-10-07. Not yet run through the subagent-smoke eval —
    // unrated until verified (see `ModelCapabilities` doc comment above).
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    thinkingApi: 'budget',
    displayName: 'Claude Haiku 4.5',
    shortDisplayName: 'Haiku 4.5',
    tier: 'economy',
    family: 'haiku',
    // Superseded by Haiku 5.5 as the current-gen economy model on 2026-10-13 —
    // kept addressable by its own id but no longer claims the shared
    // `haiku`/`claude-haiku` aliases (see aliases.ts), same handoff pattern
    // used for every prior Haiku release.
    generation: 'legacy',
    billingModel: 'haiku',
    maxOutputTokens: 64_000,
    capabilities: { subagentOrchestration: 'reliable' },
  },

  // Anthropic — legacy
  'claude-opus-5': {
    id: 'claude-opus-5',
    provider: 'anthropic',
    apiModel: 'claude-opus-5',
    thinkingApi: 'adaptive',
    displayName: 'Claude Opus 5',
    shortDisplayName: 'Opus 5',
    tier: 'premium',
    family: 'opus',
    // Superseded by Opus 5.5 as the current-gen flagship on 2026-09-22 —
    // kept addressable by its own id but no longer claims the shared
    // `opus`/`claude-opus` aliases (see aliases.ts), same handoff pattern
    // used for every prior Opus release.
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-7',
    thinkingApi: 'adaptive',
    displayName: 'Claude Opus 4.7',
    shortDisplayName: 'Opus 4.7',
    tier: 'premium',
    family: 'opus',
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 128_000,
    capabilities: { subagentOrchestration: 'reliable' },
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6',
    thinkingApi: 'adaptive',
    displayName: 'Claude Sonnet 4.6',
    shortDisplayName: 'Sonnet 4.6',
    tier: 'standard',
    family: 'sonnet',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 64_000,
    capabilities: { subagentOrchestration: 'reliable' },
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6',
    thinkingApi: 'adaptive',
    displayName: 'Claude Opus 4.6',
    shortDisplayName: 'Opus 4.6',
    tier: 'premium',
    family: 'opus',
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 128_000,
  },
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-5-20250929',
    thinkingApi: 'budget',
    displayName: 'Claude Sonnet 4.5',
    shortDisplayName: 'Sonnet 4.5',
    tier: 'standard',
    family: 'sonnet',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 64_000,
  },
  'claude-opus-4-5-20251101': {
    id: 'claude-opus-4-5-20251101',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-5-20251101',
    thinkingApi: 'budget',
    displayName: 'Claude Opus 4.5',
    shortDisplayName: 'Opus 4.5',
    tier: 'premium',
    family: 'opus',
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 64_000,
  },
  'claude-opus-4-1-20250805': {
    id: 'claude-opus-4-1-20250805',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-1-20250805',
    thinkingApi: 'budget',
    displayName: 'Claude Opus 4.1',
    shortDisplayName: 'Opus 4.1',
    tier: 'premium',
    family: 'opus',
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 32_000,
  },
  'claude-sonnet-4-20250514': {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-20250514',
    thinkingApi: 'budget',
    displayName: 'Claude Sonnet 4',
    shortDisplayName: 'Sonnet 4',
    tier: 'standard',
    family: 'sonnet',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 64_000,
  },
  'claude-3-7-sonnet-20250219': {
    id: 'claude-3-7-sonnet-20250219',
    provider: 'anthropic',
    apiModel: 'claude-3-7-sonnet-20250219',
    thinkingApi: 'budget',
    displayName: 'Claude 3.7 Sonnet',
    shortDisplayName: 'Sonnet 3.7',
    tier: 'standard',
    family: 'sonnet',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 128_000,
  },
  'claude-opus-4-20250514': {
    id: 'claude-opus-4-20250514',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-20250514',
    thinkingApi: 'budget',
    displayName: 'Claude Opus 4',
    shortDisplayName: 'Opus 4',
    tier: 'premium',
    family: 'opus',
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 32_000,
  },
  'claude-3-haiku-20240307': {
    id: 'claude-3-haiku-20240307',
    provider: 'anthropic',
    apiModel: 'claude-3-haiku-20240307',
    thinkingApi: 'budget',
    displayName: 'Claude 3 Haiku',
    shortDisplayName: 'Haiku 3',
    tier: 'economy',
    family: 'haiku',
    generation: 'legacy',
    billingModel: 'haiku',
    maxOutputTokens: 4_096,
  },

  // OpenAI — current generation
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    provider: 'openai',
    apiModel: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    shortDisplayName: 'Astra',
    tier: 'premium',
    family: 'gpt',
    generation: 'current',
    billingModel: 'gpt-6-astra',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  // GPT-6 Sol/Luna (announced 2026-09-22) take over the `sol`/`luna` slots
  // from their GPT-5.6 namesakes at half the price — see MODEL_DOLLAR_COSTS
  // and the GPT-5.6 Sol/Luna entries below, which flip to `legacy`/stay
  // `legacy` in this same change.
  'gpt-6-sol': {
    id: 'gpt-6-sol',
    provider: 'openai',
    apiModel: 'gpt-6-sol',
    displayName: 'GPT-6 Sol',
    shortDisplayName: 'Sol',
    tier: 'premium',
    family: 'gpt',
    generation: 'current',
    billingModel: 'gpt-6-sol',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  'gpt-6-luna': {
    id: 'gpt-6-luna',
    provider: 'openai',
    apiModel: 'gpt-6-luna',
    displayName: 'GPT-6 Luna',
    shortDisplayName: 'Luna',
    tier: 'economy',
    family: 'gpt',
    generation: 'current',
    billingModel: 'gpt-6-luna',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  // GPT-5.6 Terra has no GPT-6 successor yet — stays current.
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    apiModel: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    shortDisplayName: 'Terra',
    tier: 'standard',
    family: 'gpt',
    generation: 'current',
    billingModel: 'gpt-5.6-terra',
    maxOutputTokens: 128_000,
    // Not yet run through the subagent-smoke eval — unrated until verified
    // (see `ModelCapabilities` doc comment above).
  },
  'gpt-live-1': {
    id: 'gpt-live-1',
    provider: 'openai',
    apiModel: 'gpt-live-1',
    displayName: 'GPT-Live 1',
    shortDisplayName: 'GPT-Live 1',
    tier: 'standard',
    family: 'gpt',
    generation: 'current',
    kind: 'live',
    billingModel: 'gpt-live-1',
    maxOutputTokens: 0,
    usdPerMinute: 0.05,
    description: 'Full-duplex voice conversations with interruption handling and backend delegation.',
  },

  // OpenAI — audio-native (accepts `input_audio` content blocks directly;
  // see packages/agent-runtime/src/file-attachment-utils.ts for the
  // Whisper-transcription fallback used by every other model).
  'gpt-audio': {
    id: 'gpt-audio',
    provider: 'openai',
    apiModel: 'gpt-audio',
    displayName: 'GPT Audio',
    shortDisplayName: 'GPT Audio',
    tier: 'standard',
    family: 'gpt',
    generation: 'current',
    // NOTE: OpenAI bills audio input/output tokens at a much higher
    // per-token rate than text (no bucket in MODEL_DOLLAR_COSTS
    // differentiates audio tokens from text tokens today). Using the
    // most expensive existing bucket ('opus') as a conservative
    // placeholder so audio usage isn't underbilled; replace with a
    // dedicated audio billing bucket before shipping this broadly.
    billingModel: 'opus',
    maxOutputTokens: 4_096,
    description: 'Accepts spoken audio directly as input (input_audio content blocks) and can respond in text or generated speech.',
    capabilities: { supportsAudioInput: true },
  },

  // OpenAI — legacy
  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol',
    provider: 'openai',
    apiModel: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    shortDisplayName: 'Sol',
    tier: 'premium',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'gpt-5.6-sol',
    maxOutputTokens: 128_000,
  },
  // Superseded by GPT-6 Luna (2026-09-22, 50% cheaper) — see the current-gen
  // 'gpt-6-luna' entry above.
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    apiModel: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    shortDisplayName: 'Luna',
    tier: 'economy',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'gpt-5.6-luna',
    maxOutputTokens: 128_000,
  },
  'gpt-5.5': {
    id: 'gpt-5.5',
    provider: 'openai',
    apiModel: 'gpt-5.5',
    displayName: 'GPT-5.5',
    shortDisplayName: 'GPT-5.5',
    tier: 'premium',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'opus',
    maxOutputTokens: 128_000,
    capabilities: { subagentOrchestration: 'reliable' },
  },
  'gpt-5-mini': {
    id: 'gpt-5-mini',
    provider: 'openai',
    apiModel: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    shortDisplayName: 'GPT-5 Mini',
    tier: 'standard',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 128_000,
    capabilities: { subagentOrchestration: 'reliable' },
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    apiModel: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    shortDisplayName: 'GPT-5.4 Mini',
    tier: 'economy',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'gpt-5.4-mini',
    maxOutputTokens: 128_000,
    capabilities: { subagentOrchestration: 'reliable' },
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano',
    provider: 'openai',
    apiModel: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    shortDisplayName: 'GPT-5.4 Nano',
    tier: 'economy',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'gpt-5.4-nano',
    maxOutputTokens: 128_000,
    // Nano routinely fails the subagent-smoke eval (skips agent_result).
    // Flag as flaky so admins see a warning before allowlisting it for
    // workflows that fan out to children.
    capabilities: { subagentOrchestration: 'flaky' },
  },
  'gpt-4.1': {
    id: 'gpt-4.1',
    provider: 'openai',
    apiModel: 'gpt-4.1',
    displayName: 'GPT-4.1',
    shortDisplayName: 'GPT-4.1',
    tier: 'standard',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 32_768,
  },
  'gpt-4o': {
    id: 'gpt-4o',
    provider: 'openai',
    apiModel: 'gpt-4o',
    displayName: 'GPT-4o',
    shortDisplayName: 'GPT-4o',
    tier: 'standard',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 16_384,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    provider: 'openai',
    apiModel: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    shortDisplayName: 'GPT-4o Mini',
    tier: 'economy',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'haiku',
    maxOutputTokens: 16_384,
  },
  'gpt-4-turbo': {
    id: 'gpt-4-turbo',
    provider: 'openai',
    apiModel: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    shortDisplayName: 'GPT-4 Turbo',
    tier: 'standard',
    family: 'gpt',
    generation: 'legacy',
    billingModel: 'sonnet',
    maxOutputTokens: 4_096,
  },
} as const satisfies Record<string, ModelEntry>

export type ModelId = keyof typeof MODEL_CATALOG

// ---------------------------------------------------------------------------
// Image Model Catalog
// ---------------------------------------------------------------------------

const TEXT_ONLY = { textToImage: true, imageToImage: false, maxReferenceImages: 0 } as const
const GPT_IMAGE = { textToImage: true, imageToImage: true, maxReferenceImages: 16 } as const

export const IMAGE_MODEL_CATALOG = {
  // Higgsfield — the default image provider. Every call is asynchronous
  // (submit → poll), so the proxy polls inside the OpenAI-shaped route.
  // `usdPerRequest` is the 720p list price, used only for display/fallback:
  // the amount billed is always the `/estimate` captured before submit, and a
  // request that cannot be priced is refused rather than run for free.
  // (SOUL V2: $0.004 at 720p, $0.006 at 1080p — measured on the live account,
  // which is 23× below the worked example in the vendor's prose.)
  'hf-soul-v2': {
    id: 'hf-soul-v2', provider: 'higgsfield', apiModel: 'higgsfield-ai/soul/v2/standard',
    displayName: 'SOUL V2', capabilities: TEXT_ONLY, usdPerRequest: 0.004,
    bestFor: 'General-purpose default: fast, cheap editorial and product images',
  },
  'hf-ideogram-4': {
    id: 'hf-ideogram-4', provider: 'higgsfield', apiModel: 'ideogram/v4.0',
    displayName: 'Ideogram 4.0', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 1 },
    bestFor: 'Posters, logos and anything with legible text (one style reference)',
  },
  'dall-e-3':       { id: 'dall-e-3',       provider: 'openai',  apiModel: 'dall-e-3',                          displayName: 'DALL-E 3', capabilities: TEXT_ONLY, retired: true },
  'dall-e-2':       { id: 'dall-e-2',       provider: 'openai',  apiModel: 'dall-e-2',                          displayName: 'DALL-E 2', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 1 }, retired: true },
  'gpt-image-1':    { id: 'gpt-image-1',    provider: 'openai',  apiModel: 'gpt-image-1',                      displayName: 'GPT Image 1', capabilities: GPT_IMAGE },
  'gpt-image-1.5':  { id: 'gpt-image-1.5',  provider: 'openai',  apiModel: 'gpt-image-1.5',                    displayName: 'GPT Image 1.5', capabilities: GPT_IMAGE },
  'gpt-image-2':    { id: 'gpt-image-2',    provider: 'openai',  apiModel: 'gpt-image-2',                      displayName: 'GPT Image 2', capabilities: GPT_IMAGE, bestFor: 'Detailed prompt following and clean game or UI art' },
  'gpt-image-2.5-flare': { id: 'gpt-image-2.5-flare', provider: 'openai', apiModel: 'gpt-image-2.5-flare',      displayName: 'GPT Image 2.5 Flare', capabilities: GPT_IMAGE, bestFor: 'General-purpose default; strong prompt following and edits' },
  'imagen-4':       { id: 'imagen-4',       provider: 'google',  apiModel: 'imagen-4.0-generate-001',          displayName: 'Imagen 4', capabilities: TEXT_ONLY },
  'imagen-4-ultra': { id: 'imagen-4-ultra', provider: 'google',  apiModel: 'imagen-4.0-ultra-generate-001',    displayName: 'Imagen 4 Ultra', capabilities: TEXT_ONLY },
  'imagen-4-fast':  { id: 'imagen-4-fast',  provider: 'google',  apiModel: 'imagen-4.0-fast-generate-001',     displayName: 'Imagen 4 Fast', capabilities: TEXT_ONLY },
  'nano-banana-pro': {
    id: 'nano-banana-pro', provider: 'fal', apiModel: 'fal-ai/nano-banana-pro', editApiModel: 'fal-ai/nano-banana-pro/edit',
    displayName: 'Nano Banana Pro', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 14 },
    bestFor: 'Keeping a character consistent across images, edits, and legible text',
    deprecated: true, replacement: 'hf-soul-v2',
  },
  'nano-banana-2': {
    id: 'nano-banana-2', provider: 'fal', apiModel: 'fal-ai/nano-banana-2', editApiModel: 'fal-ai/nano-banana-2/edit',
    displayName: 'Nano Banana 2', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 14 },
    bestFor: 'Cheaper, faster character-consistent images and edits',
    deprecated: true, replacement: 'hf-soul-v2',
  },
  'seedream-5-pro': {
    id: 'seedream-5-pro', provider: 'fal', apiModel: 'bytedance/seedream/v5/pro/text-to-image', editApiModel: 'bytedance/seedream/v5/pro/edit',
    displayName: 'Seedream 5 Pro', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 10 },
    bestFor: 'Stylized art, composites from several references, and in-image text',
    deprecated: true, replacement: 'hf-soul-v2',
  },
  'flux-pro-ultra': {
    id: 'flux-pro-ultra', provider: 'fal', apiModel: 'fal-ai/flux-pro/v1.1-ultra',
    displayName: 'FLUX1.1 Pro Ultra', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 1 },
    bestFor: 'Photorealism',
    deprecated: true, replacement: 'hf-soul-v2',
  },
  'ideogram-3': {
    id: 'ideogram-3', provider: 'fal', apiModel: 'fal-ai/ideogram/v3',
    displayName: 'Ideogram 3', capabilities: { textToImage: true, imageToImage: true, maxReferenceImages: 3 },
    bestFor: 'Posters, logos, and anything with text in the image (references set the style)',
    deprecated: true, replacement: 'hf-ideogram-4',
  },
  'recraft-3': {
    id: 'recraft-3', provider: 'fal', apiModel: 'fal-ai/recraft/v3/text-to-image',
    displayName: 'Recraft 3', capabilities: TEXT_ONLY,
    bestFor: 'Vector-style illustration and brand graphics',
    deprecated: true, replacement: 'gpt-image-2.5-flare',
  },
} as const satisfies Record<string, ImageModelEntry>

export type ImageModelId = keyof typeof IMAGE_MODEL_CATALOG

// ---------------------------------------------------------------------------
// Video Model Catalog
// ---------------------------------------------------------------------------

/**
 * Genjutsu's published rate card, per source second, in USD.
 *
 * `/estimate` answers these three endpoints with a prose description of the
 * rate card (`{"type":"description", …$0.318/s at 480p…}`) instead of a `usd`
 * value, so there is nothing to parse: the proxy bills this table × the source
 * clip's length and refuses a job whose length it was not told.
 */
export const GENJUTSU_USD_PER_SECOND: Record<string, number> = {
  '480p': 0.318,
  '720p': 0.681,
  '1080p': 1.632,
}

export const VIDEO_MODEL_CATALOG = {
  // Higgsfield — the default video provider. Priced per clip (`usdPerRequest`,
  // approximate) rather than per second; the proxy captures the free
  // `/estimate` at submit and bills exactly that. Hailuo/Wan/Kling take no
  // aspect_ratio: the frame follows the start image (or the fixed size), so a
  // vertical ad starts from a 9:16 still (`start_image`).
  'hf-hailuo-2.3': {
    id: 'hf-hailuo-2.3', provider: 'higgsfield', displayName: 'Hailuo 2.3 Standard',
    textToVideoApiModel: 'minimax/hailuo-2.3/standard/text-to-video',
    imageToVideoApiModel: 'minimax/hailuo-2.3/standard/image-to-video',
    durations: [6, 10], defaultDuration: 6,
    aspectRatios: [],
    usdPerRequest: 0.07, maxReferenceImages: 0,
    bestFor: 'The default: cheapest clips for drafts, storyboards and b-roll (fixed 768p)',
  },
  'hf-kling-2.5-pro': {
    id: 'hf-kling-2.5-pro', provider: 'higgsfield', displayName: 'Kling 2.5 Turbo Pro',
    textToVideoApiModel: 'kling-video/v2.5-turbo/pro/text-to-video',
    imageToVideoApiModel: 'kling-video/v2.5-turbo/pro/image-to-video',
    durations: [5, 10], defaultDuration: 5,
    aspectRatios: [],
    usdPerRequest: 0.35, maxReferenceImages: 0,
    bestFor: 'Fluid motion and strong image-to-video when a shot needs more polish than Hailuo',
  },
  'hf-wan-2.6': {
    id: 'hf-wan-2.6', provider: 'higgsfield', displayName: 'Wan 2.6',
    textToVideoApiModel: 'wan/v2.6/text-to-video',
    imageToVideoApiModel: 'wan/v2.6/image-to-video',
    durations: [5, 10, 15], defaultDuration: 5,
    aspectRatios: [],
    resolutions: ['720p', '1080p'], defaultResolution: '720p',
    usdPerRequest: 0.4, maxReferenceImages: 0,
    bestFor: 'Stylized and animated looks up to 15 s, with an explicit resolution tier',
  },
  'hf-ltx-2.5-fast': {
    id: 'hf-ltx-2.5-fast', provider: 'higgsfield', displayName: 'LTX-2.5 Fast',
    textToVideoApiModel: 'lightricks/ltx-2.5/text-to-video/fast',
    imageToVideoApiModel: 'lightricks/ltx-2.5/image-to-video/fast',
    durations: [6, 8, 10], defaultDuration: 6,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'], defaultResolution: '720p',
    usdPerRequest: 0.2, maxReferenceImages: 0,
    bestFor: 'The one Higgsfield text-to-video that takes an aspect_ratio, and generates audio',
  },
  // Genjutsu — video editing. Source video is a public URL the proxy uploads
  // to; duration follows the source (4 s minimum, trimmed to 30 s). These
  // endpoints quote a prose rate card instead of a `usd` figure, so billing
  // uses `usdPerSecondByResolution` × source seconds and refuses to run a job
  // whose source duration it was not told.
  'hf-genjutsu-motion-transfer': {
    id: 'hf-genjutsu-motion-transfer', provider: 'higgsfield', displayName: 'Genjutsu Motion Transfer',
    textToVideoApiModel: 'higgsfield/genjutsu/motion-transfer/v1.0',
    durations: [], defaultDuration: 4,
    aspectRatios: [],
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
    usdPerSecondByResolution: GENJUTSU_USD_PER_SECOND,
    maxReferenceImages: 8, sourceVideo: true, genjutsu: 'motion_transfer',
    minSourceSeconds: 4, maxSourceSeconds: 30,
    bestFor: 'Drive a photo or character image with the motion of an existing clip',
  },
  'hf-genjutsu-object-swap': {
    id: 'hf-genjutsu-object-swap', provider: 'higgsfield', displayName: 'Genjutsu Object Swap',
    textToVideoApiModel: 'higgsfield/genjutsu/object-swap/v1.0',
    durations: [], defaultDuration: 4,
    aspectRatios: [],
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
    usdPerSecondByResolution: GENJUTSU_USD_PER_SECOND,
    maxReferenceImages: 8, sourceVideo: true, genjutsu: 'object_swap',
    minSourceSeconds: 4, maxSourceSeconds: 30, minSourcePixels: 409_600,
    bestFor: 'Replace an object in a clip with a product or prop from a reference image',
  },
  'hf-genjutsu-restyle': {
    id: 'hf-genjutsu-restyle', provider: 'higgsfield', displayName: 'Genjutsu Restyle',
    textToVideoApiModel: 'higgsfield/genjutsu/restyle/v1.0',
    durations: [], defaultDuration: 4,
    aspectRatios: [],
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
    usdPerSecondByResolution: GENJUTSU_USD_PER_SECOND,
    maxReferenceImages: 5, sourceVideo: true, genjutsu: 'restyle',
    minSourceSeconds: 4, maxSourceSeconds: 30, maxSourceBytes: 200 * 1024 * 1024,
    bestFor: 'Restyle a clip into another look while keeping its motion and audio (needs a preset_id)',
  },
  'kling-3-pro': {
    id: 'kling-3-pro', provider: 'fal', displayName: 'Kling 3 Pro',
    textToVideoApiModel: 'fal-ai/kling-video/v3/pro/text-to-video',
    imageToVideoApiModel: 'fal-ai/kling-video/v3/pro/image-to-video',
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5,
    aspectRatios: ['16:9', '9:16', '1:1'],
    usdPerSecond: 0.112, usdPerSecondWithAudio: 0.168, maxReferenceImages: 4,
    bestFor: 'Fluid motion and keeping characters consistent via reference images',
    deprecated: true, replacement: 'hf-kling-2.5-pro',
  },
  'kling-2.5-turbo-pro': {
    id: 'kling-2.5-turbo-pro', provider: 'fal', displayName: 'Kling 2.5 Turbo Pro',
    textToVideoApiModel: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    imageToVideoApiModel: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    durations: [5, 10], defaultDuration: 5,
    aspectRatios: ['16:9', '9:16', '1:1'],
    usdPerSecond: 0.07, maxReferenceImages: 0,
    bestFor: 'Cheap, silent clips for drafts and storyboard animatics',
    deprecated: true, replacement: 'hf-hailuo-2.3',
  },
  'veo-3.1-fast': {
    id: 'veo-3.1-fast', provider: 'fal', displayName: 'Veo 3.1 Fast',
    textToVideoApiModel: 'fal-ai/veo3.1/fast',
    imageToVideoApiModel: 'fal-ai/veo3.1/fast/image-to-video',
    durations: [4, 6, 8], defaultDuration: 8,
    aspectRatios: ['16:9', '9:16'],
    usdPerSecond: 0.10, usdPerSecondWithAudio: 0.15, maxReferenceImages: 0,
    bestFor: 'Cinematic shots with synced dialogue and sound',
    deprecated: true, replacement: 'hf-ltx-2.5-fast',
  },
  'minimax-h3-max': {
    id: 'minimax-h3-max', provider: 'fal', displayName: 'MiniMax H3 Max',
    textToVideoApiModel: 'minimax/h3-max/text-to-video',
    imageToVideoApiModel: 'minimax/h3-max/image-to-video',
    durations: [2, 3, 4, 5, 6, 8, 10, 12, 15], defaultDuration: 5,
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    usdPerSecond: 0.08, maxReferenceImages: 0,
    bestFor: 'Stylized and animated looks at a low price',
    deprecated: true, replacement: 'hf-wan-2.6',
  },
} as const satisfies Record<string, VideoModelEntry>

export type VideoModelId = keyof typeof VIDEO_MODEL_CATALOG
