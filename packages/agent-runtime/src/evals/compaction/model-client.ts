// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model client the compaction eval talks to.
 *
 * One credential, one endpoint: the Shogo AI gateway's OpenAI-compatible
 * `/chat/completions` (the same surface `client.llm` exposes to apps). It
 * reports per-call `usage.cost`, so the eval's spend is measured rather than
 * estimated from a price table that can be a month stale.
 *
 * Configuration, in order: `SHOGO_AI_BASE_URL` (+ `SHOGO_AI_API_KEY`), else the
 * local install's `~/.shogo/config.json` (`cloudUrl` + `apiKey`). Nothing is
 * hardcoded to a host, and a missing key fails loudly instead of reporting a
 * green run over zero calls.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CallUsage } from './types'

export interface ChatToolSpec {
  name: string
  description: string
  parameters: Record<string, any>
}

export interface ChatClient {
  model: string
  complete(opts: { system: string; prompt: string; maxTokens?: number }): Promise<{ text: string; usage: CallUsage }>
  /** One model step with tools offered and nothing executed. */
  firstToolCall(opts: {
    system: string
    prompt: string
    tools: ChatToolSpec[]
  }): Promise<{ tool: string | null; args: Record<string, any>; text: string; usage: CallUsage }>
}

interface ShogoConfig {
  apiKey?: string
  cloudUrl?: string
}

function readConfig(): ShogoConfig {
  const path = join(homedir(), '.shogo', 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ShogoConfig
  } catch {
    return {}
  }
}

/** The gateway base, e.g. `https://api.shogo.ai/api/ai/v1`. */
export function resolveAiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.SHOGO_AI_BASE_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const cloud = (env.SHOGO_CLOUD_URL?.trim() || readConfig().cloudUrl || '').replace(/\/$/, '')
  if (!cloud) throw new Error('No AI gateway: set SHOGO_AI_BASE_URL or SHOGO_CLOUD_URL')
  return `${cloud}/api/ai/v1`
}

export function resolveAiApiKey(env: Record<string, string | undefined> = process.env): string {
  const key = env.SHOGO_AI_API_KEY?.trim() || readConfig().apiKey?.trim()
  if (!key) throw new Error('No AI gateway credential: set SHOGO_AI_API_KEY or ~/.shogo/config.json apiKey')
  return key
}

const ZERO_USAGE: CallUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  latencyMs: 0,
}

function usageOf(payload: any, latencyMs: number): CallUsage {
  const u = payload?.usage ?? {}
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0)
  return {
    inputTokens: Number(u.prompt_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: Number(u.prompt_tokens_details?.cache_write_tokens ?? 0),
    costUsd: Number(u.cost ?? 0),
    latencyMs,
  }
}

/** `createShogoChatClient` — one model id, one endpoint, real usage back. */
export function createShogoChatClient(model: string, opts: { fetchImpl?: typeof fetch } = {}): ChatClient {
  const base = resolveAiBaseUrl()
  const key = resolveAiApiKey()
  const doFetch = opts.fetchImpl ?? fetch

  async function post(body: Record<string, any>): Promise<any> {
    const started = Date.now()
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`AI gateway ${res.status}: ${text.slice(0, 300)}`)
    const parsed = JSON.parse(text)
    return { parsed, latencyMs: Date.now() - started }
  }

  function messageOf(payload: any): { text: string; calls: Array<{ name: string; args: Record<string, any> }> } {
    const msg = payload?.choices?.[0]?.message ?? {}
    const text = typeof msg.content === 'string' ? msg.content : ''
    const calls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((c: any) => {
          let args: Record<string, any> = {}
          try {
            args = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments) : (c.function?.arguments ?? {})
          } catch {
            args = {}
          }
          return { name: String(c.function?.name ?? ''), args }
        })
      : []
    return { text, calls }
  }

  return {
    model,

    async complete({ system, prompt, maxTokens }) {
      const { parsed, latencyMs } = await post({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens ?? 2_000,
        temperature: 0,
      })
      return { text: messageOf(parsed).text, usage: usageOf(parsed, latencyMs) ?? ZERO_USAGE }
    },

    async firstToolCall({ system, prompt, tools }) {
      const { parsed, latencyMs } = await post({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
        max_tokens: 1_500,
        temperature: 0,
      })
      const { text, calls } = messageOf(parsed)
      const first = calls[0]
      return {
        tool: first?.name ?? null,
        args: first?.args ?? {},
        text,
        usage: usageOf(parsed, latencyMs),
      }
    },
  }
}
