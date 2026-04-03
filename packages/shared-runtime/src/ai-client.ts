// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Simple Anthropic Messages API client.
 *
 * For one-shot LLM calls (classification, generation, extraction) where
 * a full Claude Code session is overkill. Respects the AI proxy config
 * (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY) so it works in both local-dev
 * and production environments.
 */

import { getMaxOutputTokens } from '@shogo/model-catalog'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface SendMessageOptions {
  /** Model to use. Defaults to claude-sonnet-4-5-20250514 */
  model?: string
  /** System prompt */
  system?: string
  /** Max tokens to generate. Defaults to the model's max from the catalog. */
  maxTokens?: number
  /** Temperature. Defaults to 0 */
  temperature?: number
  /** Explicit API key (overrides env) */
  apiKey?: string
  /** Explicit base URL (overrides env) */
  baseUrl?: string
}

export interface MessageResponse {
  text: string
  inputTokens: number
  outputTokens: number
  stopReason: string
}

function resolveConfig(options?: SendMessageOptions) {
  const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'No Anthropic API key found. Set ANTHROPIC_API_KEY or pass apiKey option.'
    )
  }
  const baseUrl = options?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL
  return { apiKey, baseUrl }
}

/**
 * Send a single message to Claude and get the full text response.
 *
 * ```ts
 * const { text } = await sendMessage('Summarize this in 3 bullets: ...')
 * ```
 */
export async function sendMessage(
  prompt: string,
  options?: SendMessageOptions,
): Promise<MessageResponse> {
  return sendMessages([{ role: 'user', content: prompt }], options)
}

/**
 * Send a multi-turn conversation to Claude and get the full text response.
 */
export async function sendMessages(
  messages: Message[],
  options?: SendMessageOptions,
): Promise<MessageResponse> {
  const { apiKey, baseUrl } = resolveConfig(options)
  const model = options?.model ?? 'claude-sonnet-4-6'

  const body: Record<string, unknown> = {
    model,
    max_tokens: options?.maxTokens ?? getMaxOutputTokens(model),
    temperature: options?.temperature ?? 0,
    messages,
  }
  if (options?.system) {
    body.system = options.system
  }

  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${errorBody}`)
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>
    usage: { input_tokens: number; output_tokens: number }
    stop_reason: string
  }

  const text = data.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')

  return {
    text,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    stopReason: data.stop_reason,
  }
}

/**
 * Send a message and parse the response as JSON.
 * Strips markdown code fences if present.
 *
 * ```ts
 * const data = await sendMessageJSON<{ items: string[] }>(
 *   'List 5 colors as JSON: { "items": [...] }'
 * )
 * ```
 */
export async function sendMessageJSON<T = unknown>(
  prompt: string,
  options?: SendMessageOptions,
): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number } }> {
  const response = await sendMessage(prompt, options)
  let raw = response.text.trim()

  // Strip ```json ... ``` fences
  const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/)
  if (fenceMatch) raw = fenceMatch[1]

  return {
    data: JSON.parse(raw) as T,
    usage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  }
}
