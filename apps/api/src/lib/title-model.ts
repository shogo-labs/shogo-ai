// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Title-generation model resolution + execution.
 *
 * Chat/project titles are produced by `POST /api/generate-project-name`. The
 * model that route uses is super-admin selectable via the PlatformSetting
 * `title-generation.model` (managed from the admin AI page). When unset it
 * defaults to Claude Haiku, preserving the historical behavior.
 *
 * Supported providers:
 *   - native Anthropic — via `@ai-sdk/anthropic` (`ANTHROPIC_API_KEY`).
 *   - custom OpenAI-compatible (e.g. Hoshi / MiMo) — a raw fetch to
 *     `${baseUrl}/chat/completions`, mirroring `routes/ai-proxy.ts` so no new
 *     provider SDK dependency is needed.
 *
 * Anything else (native OpenAI, OpenRouter) is unsupported here; the configured
 * model then falls back to the default Haiku model, and the caller falls back
 * to a heuristic name when no model can produce a result.
 */
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  getDbRoutingConfigSync,
  getMergedModelEntrySync,
} from '../services/model-registry.service'

/** Default model id used when no admin override is configured. Matches the
 *  historical hardcoded Haiku model so behavior is unchanged out of the box. */
export const DEFAULT_TITLE_MODEL_ID = 'claude-haiku-4-5-20251001'

/** PlatformSetting key holding the admin-selected title-generation model id. */
export const TITLE_MODEL_SETTING_KEY = 'title-generation.model'

let configuredTitleModelId: string | null = null

/** Update the in-memory configured model id (called at boot + after admin PUT). */
export function setTitleGenerationModelId(id: string | null | undefined): void {
  const trimmed = (id ?? '').trim()
  configuredTitleModelId = trimmed.length > 0 ? trimmed : null
}

/** The configured model id, or the default when unset. */
export function getTitleGenerationModelId(): string {
  return configuredTitleModelId ?? DEFAULT_TITLE_MODEL_ID
}

export interface TitleCompletionResult {
  text: string
  inputTokens: number
  outputTokens: number
  /** Model id to bill against (drives DB per-token pricing in calculateUsageCost). */
  billingModelId: string
}

export interface TitleCompletionOptions {
  system: string
  prompt: string
  maxTokens?: number
}

/** Single-shot OpenAI-compatible chat completion (custom providers: Hoshi/MiMo). */
async function runOpenAiCompatible(
  apiModel: string,
  baseUrl: string,
  apiKey: string,
  authStyle: 'bearer' | 'api-key-header',
  billingModelId: string,
  opts: TitleCompletionOptions,
): Promise<TitleCompletionResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authStyle === 'api-key-header') headers['api-key'] = apiKey
  else headers['Authorization'] = `Bearer ${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: apiModel,
      max_tokens: opts.maxTokens ?? 80,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.prompt },
      ],
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`title model upstream ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data: any = await res.json()
  const content = data?.choices?.[0]?.message?.content
  const usage = data?.usage ?? {}
  return {
    text: typeof content === 'string' ? content : '',
    inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
    outputTokens: usage.completion_tokens || usage.output_tokens || 0,
    billingModelId,
  }
}

/**
 * Run a single-shot completion for one model id. Throws on unsupported
 * providers or upstream errors so the caller can fall back.
 */
async function runModel(
  modelId: string,
  opts: TitleCompletionOptions,
): Promise<TitleCompletionResult> {
  const entry = getMergedModelEntrySync(modelId)
  const provider = entry?.provider
  const apiModel = entry?.apiModel ?? modelId

  // Custom OpenAI-compatible providers (Hoshi / MiMo).
  if (provider === 'custom') {
    const routing = getDbRoutingConfigSync(modelId)
    if (!routing?.baseUrl || !routing.apiKey) {
      throw new Error(`title model "${modelId}" custom provider not configured`)
    }
    return runOpenAiCompatible(
      routing.apiModel || apiModel,
      routing.baseUrl,
      routing.apiKey,
      routing.authStyle ?? 'bearer',
      modelId,
      opts,
    )
  }

  // Native Anthropic (static catalog or a DB-defined anthropic model).
  const looksAnthropic =
    provider === 'anthropic' ||
    (!provider && (modelId.startsWith('claude') || apiModel.startsWith('claude')))
  if (looksAnthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set for anthropic title model')
    }
    const anthropic = createAnthropic()
    const result = await generateText({
      model: anthropic(apiModel),
      maxOutputTokens: opts.maxTokens ?? 80,
      system: opts.system,
      prompt: opts.prompt,
    })
    const usage = result.usage as any
    return {
      text: result.text,
      inputTokens: usage?.inputTokens || usage?.promptTokens || 0,
      outputTokens: usage?.outputTokens || usage?.completionTokens || 0,
      billingModelId: modelId,
    }
  }

  throw new Error(
    `title model "${modelId}" (provider "${provider ?? 'unknown'}") is not supported for title generation`,
  )
}

/**
 * Generate a title completion using the admin-configured model, falling back
 * to the default Haiku model when the configured one fails or is unsupported.
 * Throws only when no model can produce a result (caller uses a heuristic).
 */
export async function generateTitleCompletion(
  opts: TitleCompletionOptions,
): Promise<TitleCompletionResult> {
  const configured = getTitleGenerationModelId()
  const candidates =
    configured === DEFAULT_TITLE_MODEL_ID ? [configured] : [configured, DEFAULT_TITLE_MODEL_ID]

  let lastErr: unknown
  for (const id of candidates) {
    try {
      return await runModel(id, opts)
    } catch (err) {
      lastErr = err
      console.warn(
        `[title-model] generation failed for "${id}":`,
        (err as any)?.message ?? err,
      )
    }
  }
  throw lastErr ?? new Error('no title model available')
}
