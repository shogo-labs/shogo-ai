// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Special model ID that enables the intelligent model router. */
export const AUTO_MODEL_ID = 'auto' as const

export type Provider = 'anthropic' | 'openai' | 'google' | 'local'
export type ImageProvider = 'openai' | 'google' | 'local'
export type ModelTier = 'economy' | 'standard' | 'premium'
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other'
export type ModelGeneration = 'current' | 'legacy'
export type BillingModel = 'gpt-5.4-nano' | 'haiku' | 'gpt-5.4-mini' | 'sonnet' | 'opus'
export type AgentMode = 'basic' | 'advanced'

export interface ModelEntry {
  id: string
  provider: Provider
  apiModel: string
  displayName: string
  shortDisplayName: string
  tier: ModelTier
  family: ModelFamily
  generation: ModelGeneration
  billingModel: BillingModel
  maxOutputTokens: number
}

export interface ImageModelEntry {
  id: string
  provider: ImageProvider
  apiModel: string
  displayName: string
}

// ---------------------------------------------------------------------------
// Chat Model Catalog — single source of truth
// ---------------------------------------------------------------------------

export const MODEL_CATALOG = {
  // Anthropic — current generation
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    shortDisplayName: 'Opus 4.6',
    tier: 'premium',
    family: 'opus',
    generation: 'current',
    billingModel: 'opus',
    maxOutputTokens: 128_000,
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    shortDisplayName: 'Sonnet 4.6',
    tier: 'standard',
    family: 'sonnet',
    generation: 'current',
    billingModel: 'sonnet',
    maxOutputTokens: 64_000,
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    shortDisplayName: 'Haiku 4.5',
    tier: 'economy',
    family: 'haiku',
    generation: 'current',
    billingModel: 'haiku',
    maxOutputTokens: 64_000,
  },

  // Anthropic — legacy
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-5-20250929',
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
    displayName: 'Claude 3 Haiku',
    shortDisplayName: 'Haiku 3',
    tier: 'economy',
    family: 'haiku',
    generation: 'legacy',
    billingModel: 'haiku',
    maxOutputTokens: 4_096,
  },

  // OpenAI — current generation
  'gpt-5.4': {
    id: 'gpt-5.4',
    provider: 'openai',
    apiModel: 'gpt-5.4',
    displayName: 'GPT-5.4',
    shortDisplayName: 'GPT-5.4',
    tier: 'premium',
    family: 'gpt',
    generation: 'current',
    billingModel: 'opus',
    maxOutputTokens: 128_000,
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    apiModel: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    shortDisplayName: 'GPT-5.4 Mini',
    tier: 'economy',
    family: 'gpt',
    generation: 'current',
    billingModel: 'gpt-5.4-mini',
    maxOutputTokens: 128_000,
  },
  'gpt-5-mini': {
    id: 'gpt-5-mini',
    provider: 'openai',
    apiModel: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    shortDisplayName: 'GPT-5 Mini',
    tier: 'standard',
    family: 'gpt',
    generation: 'current',
    billingModel: 'sonnet',
    maxOutputTokens: 128_000,
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano',
    provider: 'openai',
    apiModel: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    shortDisplayName: 'GPT-5.4 Nano',
    tier: 'economy',
    family: 'gpt',
    generation: 'current',
    billingModel: 'gpt-5.4-nano',
    maxOutputTokens: 128_000,
  },
  // OpenAI — legacy
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

export const IMAGE_MODEL_CATALOG = {
  'dall-e-3':       { id: 'dall-e-3',       provider: 'openai',  apiModel: 'dall-e-3',                          displayName: 'DALL-E 3' },
  'dall-e-2':       { id: 'dall-e-2',       provider: 'openai',  apiModel: 'dall-e-2',                          displayName: 'DALL-E 2' },
  'gpt-image-1':    { id: 'gpt-image-1',    provider: 'openai',  apiModel: 'gpt-image-1',                      displayName: 'GPT Image 1' },
  'gpt-image-1.5':  { id: 'gpt-image-1.5',  provider: 'openai',  apiModel: 'gpt-image-1.5',                    displayName: 'GPT Image 1.5' },
  'imagen-4':       { id: 'imagen-4',       provider: 'google',  apiModel: 'imagen-4.0-generate-001',          displayName: 'Imagen 4' },
  'imagen-4-ultra': { id: 'imagen-4-ultra', provider: 'google',  apiModel: 'imagen-4.0-ultra-generate-001',    displayName: 'Imagen 4 Ultra' },
  'imagen-4-fast':  { id: 'imagen-4-fast',  provider: 'google',  apiModel: 'imagen-4.0-fast-generate-001',     displayName: 'Imagen 4 Fast' },
} as const satisfies Record<string, ImageModelEntry>

export type ImageModelId = keyof typeof IMAGE_MODEL_CATALOG
