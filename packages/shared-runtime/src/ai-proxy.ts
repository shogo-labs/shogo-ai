// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI proxy configuration for Claude Code SDK sessions.
 * Routes Claude API requests through the API server's proxy endpoint
 * instead of requiring a raw ANTHROPIC_API_KEY in the runtime process.
 *
 * Shared between runtime and agent-runtime.
 *
 * Local-dev policy: when AI_PROXY_URL is present the proxy MUST be used.
 * The raw ANTHROPIC_API_KEY is always stripped from child-process environments
 * to prevent silent fallbacks to an account-level key.
 */

export interface AIProxyConfig {
  useProxy: boolean
  /** Environment overrides to spread into process.env or pass to Claude Code sessions */
  env: Record<string, string>
}

/**
 * Keys that are stripped from child environments whenever the proxy is active,
 * ensuring the runtime never falls back to raw platform API keys.
 */
const PROXY_SHADOW_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const

/**
 * Configure AI proxy.
 *
 * Accepts explicit `url` and `token` values so callers (e.g. the runtime
 * manager) can inject freshly-generated, project-scoped tokens without
 * relying on process.env propagation.
 *
 * Falls back to AI_PROXY_URL / AI_PROXY_TOKEN from process.env when explicit
 * values are not supplied — e.g. when the runtime reads its own environment
 * after the manager has already set those vars on the child process.
 *
 * Local-dev guard: if AI_PROXY_URL is set but no token is resolvable, throws
 * rather than silently falling back to a raw ANTHROPIC_API_KEY.
 */
export function configureAIProxy(options?: {
  logPrefix?: string
  /** Explicit proxy base URL — takes precedence over AI_PROXY_URL env var */
  url?: string
  /** Explicit proxy token — takes precedence over AI_PROXY_TOKEN env var */
  token?: string
}): AIProxyConfig {
  const prefix = options?.logPrefix ?? 'runtime'
  const proxyUrl = options?.url ?? process.env.AI_PROXY_URL
  const proxyToken = options?.token ?? process.env.AI_PROXY_TOKEN

  if (!proxyUrl) {
    console.log(`[${prefix}] AI Proxy not configured, using direct ANTHROPIC_API_KEY`)
    return { useProxy: false, env: {} }
  }

  if (!proxyToken) {
    // Proxy URL is set but we have no token — fail loudly instead of
    // silently falling back to the raw platform API key.
    throw new Error(
      `[${prefix}] AI_PROXY_URL is set (${proxyUrl}) but no proxy token is available. ` +
      `Set AI_PROXY_TOKEN or pass an explicit token to configureAIProxy().`
    )
  }

  // AI_PROXY_URL is like: http://api-server/api/ai/v1
  // Anthropic base URL: http://api-server/api/ai/anthropic
  // OpenAI base URL:    http://api-server/api/ai/v1 (SDK appends /chat/completions)
  const anthropicProxyBase = proxyUrl.replace(/\/v1$/, '/anthropic')
  const openaiProxyBase = proxyUrl
  console.log(`[${prefix}] AI Proxy enabled: Anthropic → ${anthropicProxyBase}, OpenAI → ${openaiProxyBase}`)
  console.log(`[${prefix}] Proxy token: ${proxyToken.slice(0, 20)}...`)

  return {
    useProxy: true,
    env: {
      ANTHROPIC_BASE_URL: anthropicProxyBase,
      ANTHROPIC_API_KEY: proxyToken,
      OPENAI_BASE_URL: openaiProxyBase,
      OPENAI_API_KEY: proxyToken,
    },
  }
}

/**
 * Build the full environment for a Claude Code session.
 *
 * Inherits all current process.env values, then:
 * - When proxy is active: overlays ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
 *   (the raw platform key is overwritten with the scoped proxy token)
 * - Always strips the raw ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL when the
 *   proxy is active so Claude Code cannot fall back to a platform-level key.
 */
export function buildClaudeCodeEnv(proxyConfig: AIProxyConfig, extraEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
  }

  if (proxyConfig.useProxy) {
    // Strip raw platform keys before applying proxy overrides so there is
    // no window where the old value could be read.
    for (const key of PROXY_SHADOW_KEYS) {
      delete env[key]
    }
    Object.assign(env, proxyConfig.env)
  }

  if (extraEnv) {
    Object.assign(env, extraEnv)
  }
  return env
}
