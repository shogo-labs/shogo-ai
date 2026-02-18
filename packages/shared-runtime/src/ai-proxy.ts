/**
 * AI proxy configuration for Claude Code SDK sessions.
 * Routes Claude API requests through the API server's proxy endpoint
 * instead of requiring a raw ANTHROPIC_API_KEY in the runtime process.
 *
 * Shared between project-runtime and agent-runtime.
 */

export interface AIProxyConfig {
  useProxy: boolean
  /** Environment overrides to spread into process.env or pass to Claude Code sessions */
  env: Record<string, string>
}

/**
 * Configure AI proxy from environment variables.
 *
 * When AI_PROXY_URL and AI_PROXY_TOKEN are set:
 * - Derives the Anthropic-native proxy base URL
 * - Returns env overrides for ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY
 *
 * The caller decides whether to set process.env or pass to session options.
 */
export function configureAIProxy(options?: { logPrefix?: string }): AIProxyConfig {
  const prefix = options?.logPrefix ?? 'runtime'
  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  if (!proxyUrl || !proxyToken) {
    console.log(`[${prefix}] AI Proxy not configured, using direct ANTHROPIC_API_KEY`)
    return { useProxy: false, env: {} }
  }

  // AI_PROXY_URL is like: http://api-server/api/ai/v1
  // Anthropic base URL should be: http://api-server/api/ai/anthropic
  const anthropicProxyBase = proxyUrl.replace(/\/v1$/, '/anthropic')
  console.log(`[${prefix}] AI Proxy enabled: Claude Code → ${anthropicProxyBase}`)

  return {
    useProxy: true,
    env: {
      ANTHROPIC_BASE_URL: anthropicProxyBase,
      ANTHROPIC_API_KEY: proxyToken,
    },
  }
}

/**
 * Build the full environment for a Claude Code session.
 * Inherits all current process.env values and overlays proxy config when enabled.
 */
export function buildClaudeCodeEnv(proxyConfig: AIProxyConfig, extraEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
  }
  if (proxyConfig.useProxy) {
    Object.assign(env, proxyConfig.env)
  }
  if (extraEnv) {
    Object.assign(env, extraEnv)
  }
  return env
}
