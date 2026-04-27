// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk LLM Gateway
 *
 * Turns a Shogo API key (`shogo_sk_*`) into a drop-in Vercel AI SDK provider
 * pointed at the Shogo Cloud OpenAI-compatible proxy
 * (`/api/ai/v1/chat/completions`). The proxy routes to Anthropic, OpenAI,
 * Google, or a local LLM server-side based on the model id, so apps only
 * need one key and one base URL.
 *
 * @example
 * ```ts
 * import { createClient } from '@shogo-ai/sdk'
 * import { streamText } from 'ai'
 *
 * const shogo = createClient({
 *   apiUrl: 'http://localhost:3000',
 *   shogoApiKey: process.env.SHOGO_API_KEY!, // shogo_sk_...
 * })
 *
 * const result = streamText({
 *   model: shogo.llm!('claude-sonnet-4-5'),
 *   prompt: 'Hello, Shogo!',
 * })
 * ```
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/** Default Shogo Cloud base URL (no trailing slash, no `/api/ai/v1` suffix). */
export const DEFAULT_SHOGO_CLOUD_URL = 'https://studio.shogo.ai'

export interface CreateShogoLlmProviderOptions {
  /** Shogo API key (starts with `shogo_sk_`). Sent as `Authorization: Bearer <key>`. */
  apiKey: string
  /**
   * Override the Shogo Cloud base URL (without the `/api/ai/v1` suffix).
   * Defaults to {@link DEFAULT_SHOGO_CLOUD_URL}. Useful for staging / self-hosted
   * Shogo deployments.
   */
  baseUrl?: string
  /**
   * Extra headers appended to every request. Added _after_ the `Authorization`
   * header set from `apiKey`, so they can override it if needed.
   */
  headers?: Record<string, string>
  /** Custom fetch implementation (e.g. for tests or edge runtimes). */
  fetch?: typeof fetch
  /** Include token usage in streaming responses. Defaults to `true`. */
  includeUsage?: boolean
}

/**
 * Provider returned by {@link createShogoLlmProvider}. Callable as
 * `provider('model-id')` to build a `LanguageModelV2` usable by the AI SDK's
 * `generateText`, `streamText`, and `generateObject`.
 */
export type ShogoLlmProvider = ReturnType<typeof createOpenAICompatible>

/**
 * Create a Vercel AI SDK provider that routes through the Shogo Cloud LLM
 * gateway. Users only need their Shogo API key; model routing (Anthropic /
 * OpenAI / Google / local) happens server-side.
 *
 * ```ts
 * import { createShogoLlmProvider } from '@shogo-ai/sdk'
 * import { generateText } from 'ai'
 *
 * const shogo = createShogoLlmProvider({ apiKey: process.env.SHOGO_API_KEY! })
 * const { text } = await generateText({
 *   model: shogo('claude-sonnet-4-5'),
 *   prompt: 'hi',
 * })
 * ```
 */
export function createShogoLlmProvider(
  opts: CreateShogoLlmProviderOptions,
): ShogoLlmProvider {
  const root = (opts.baseUrl ?? DEFAULT_SHOGO_CLOUD_URL).replace(/\/$/, '')
  return createOpenAICompatible({
    name: 'shogo',
    baseURL: `${root}/api/ai/v1`,
    apiKey: opts.apiKey,
    headers: opts.headers,
    fetch: opts.fetch,
    includeUsage: opts.includeUsage ?? true,
  })
}
