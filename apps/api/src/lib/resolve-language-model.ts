// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared multi-provider model resolver.
 *
 * Returns an `ai`-SDK `LanguageModel` for any model id so the in-app assistant
 * surfaces (`routes/chat.ts`, `routes/voice.ts`, `lib/title-model.ts`) can all
 * route to ANY provider — not just Anthropic — without each one re-implementing
 * provider selection:
 *
 *   - Anthropic-family models route through the proxy's `/ai/anthropic/v1`
 *     Messages endpoint (with a direct `ANTHROPIC_API_KEY` fallback for local
 *     dev when no proxy is configured).
 *   - Custom OpenAI-compatible models (e.g. Hoshi / MiMo) — and native OpenAI —
 *     route through the proxy's `/ai/v1` chat-completions endpoint.
 *
 * Both proxy endpoints resolve the model id and meter usage server-side, so
 * callers do not duplicate billing.
 *
 * Resolution mirrors `lib/title-model.ts`: a public alias (e.g. `hoshi-1.0`) is
 * resolved to its backing model id, then the merged registry supplies the
 * provider + apiModel. The proxy's own `resolveModel` accepts DB-defined model
 * ids/aliases (custom providers), so the custom branch forwards the backing id;
 * the Anthropic branch forwards the real `apiModel` name.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { getMergedModelEntrySync } from '../services/model-registry.service'
import { resolvePublicModelSync } from '../services/public-models.service'

/**
 * Default model used by the in-app assistant surfaces (project chat, voice
 * translator, title generation) when nothing more specific is configured.
 * Expressed as a public alias so `resolveLanguageModel` resolves it to the
 * current backing model id at call time.
 */
export const DEFAULT_ASSISTANT_MODEL = 'hoshi-1.0'

export interface ResolvedLanguageModel {
  /** AI-SDK model instance usable with `streamText` / `generateText`. */
  model: LanguageModel
  /** Canonical/backing model id to bill + log against. */
  billingModelId: string
  provider: 'anthropic' | 'custom'
}

export interface ResolveLanguageModelOptions {
  /**
   * Extra HTTP headers forwarded on every model request. Used by internal
   * surfaces (e.g. title generation) to tag completions for the proxy — see
   * `routes/ai-proxy.ts` `resolveInternalUsage`.
   */
  headers?: Record<string, string>
}

/**
 * Resolve a model id to an `ai`-SDK `LanguageModel`.
 *
 * Returns `null` when no transport is configured — i.e. neither the Shogo
 * proxy (`AI_PROXY_URL` + `AI_PROXY_TOKEN`) nor, for Anthropic models, a direct
 * `ANTHROPIC_API_KEY`. Callers should surface a 503 in that case.
 */
export function resolveLanguageModel(
  modelId: string,
  opts?: ResolveLanguageModelOptions,
): ResolvedLanguageModel | null {
  const headers = opts?.headers
  // Resolve a public alias (e.g. `hoshi-1.0`) to its backing id so the registry
  // and proxy can route it; non-aliases pass through unchanged.
  const alias = resolvePublicModelSync(modelId)
  const backingId = alias?.backingModelId?.trim() || modelId

  const entry = getMergedModelEntrySync(backingId)
  const apiModel = entry?.apiModel ?? backingId
  const provider = entry?.provider

  const looksAnthropic =
    provider === 'anthropic' ||
    (!provider && (backingId.startsWith('claude') || apiModel.startsWith('claude')))

  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  if (looksAnthropic) {
    if (proxyUrl && proxyToken) {
      // e.g. http://.../api/ai/v1 -> http://.../api/ai/anthropic/v1
      const anthropicProxyUrl = proxyUrl.replace('/ai/v1', '/ai/anthropic/v1')
      const anthropic = createAnthropic({ baseURL: anthropicProxyUrl, apiKey: proxyToken, headers })
      return { model: anthropic(apiModel), billingModelId: backingId, provider: 'anthropic' }
    }
    // Local-dev fallback — talk to Anthropic directly.
    const directKey = process.env.ANTHROPIC_API_KEY
    if (directKey) {
      const anthropic = createAnthropic({ apiKey: directKey, headers })
      return { model: anthropic(apiModel), billingModelId: backingId, provider: 'anthropic' }
    }
    return null
  }

  // Custom / OpenAI-compatible providers (Hoshi / MiMo, native OpenAI) route
  // through the proxy's OpenAI-compatible endpoint. The proxy's `resolveModel`
  // resolves DB-defined ids/aliases server-side, so forward the backing id
  // (not the upstream apiModel) and let the proxy map it to the provider.
  if (proxyUrl && proxyToken) {
    const openai = createOpenAICompatible({
      name: 'shogo',
      baseURL: proxyUrl,
      apiKey: proxyToken,
      includeUsage: true,
      headers,
    })
    return { model: openai(backingId), billingModelId: backingId, provider: 'custom' }
  }

  return null
}
