// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Title-generation model resolution + execution.
 *
 * Chat/project titles are produced by `POST /api/generate-project-name`. The
 * model that route uses is super-admin selectable via the PlatformSetting
 * `title-generation.model` (managed from the admin AI page). When unset it
 * defaults to the shared in-app assistant model (`DEFAULT_ASSISTANT_MODEL`).
 *
 * Provider handling is delegated to the shared `resolveLanguageModel` helper
 * (`lib/resolve-language-model.ts`), so title generation supports the same set
 * of providers as the chat / voice surfaces — Anthropic and custom
 * OpenAI-compatible models (e.g. Hoshi / MiMo) — all routed through the proxy,
 * which meters usage. The configured model falls back to the default when it
 * can't be resolved, and the caller falls back to a heuristic name when no
 * model can produce a result.
 */
import { generateText } from 'ai'
import {
  resolveLanguageModel,
  DEFAULT_ASSISTANT_MODEL,
} from './resolve-language-model'

/** Default model id used when no admin override is configured. */
export const DEFAULT_TITLE_MODEL_ID = DEFAULT_ASSISTANT_MODEL

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

/**
 * Run a single-shot completion for one model id via the shared multi-provider
 * resolver. Throws when the model can't be resolved (no transport configured)
 * or on upstream errors so the caller can fall back.
 */
async function runModel(
  modelId: string,
  opts: TitleCompletionOptions,
): Promise<TitleCompletionResult> {
  // Tag the proxy request as internal title-generation usage: the proxy records
  // the real cost for ADMIN cost-tracking but does NOT bill the user or surface
  // it in the user-facing usage log. See `routes/ai-proxy.ts` `resolveInternalUsage`.
  const resolved = resolveLanguageModel(modelId, {
    headers: { 'x-shogo-usage-tag': 'title_generation' },
  })
  if (!resolved) {
    throw new Error(
      `title model "${modelId}" could not be resolved (no provider transport configured)`,
    )
  }

  const result = await generateText({
    model: resolved.model,
    maxOutputTokens: opts.maxTokens ?? 80,
    system: opts.system,
    prompt: opts.prompt,
  })
  const usage = result.usage as any
  return {
    text: result.text,
    inputTokens: usage?.inputTokens || usage?.promptTokens || 0,
    outputTokens: usage?.outputTokens || usage?.completionTokens || 0,
    billingModelId: resolved.billingModelId,
  }
}

/**
 * Generate a title completion using the admin-configured model, falling back
 * to the default model when the configured one fails or is unsupported.
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
