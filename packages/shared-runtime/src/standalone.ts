// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Standalone runtime mode — `SHOGO_STANDALONE=1`.
 *
 * A standalone runtime runs on a partner's own infrastructure with **no Shogo
 * API behind it**. Everything that used to be answered by the platform (trust
 * level, capability toggles, subagent model overrides, task notifications, cost
 * metrics, git-sync bootstrap, runtime-token validation) is either statically
 * configured or switched off.
 *
 * The single switch that makes that true is {@link resolveApiUrl}: it returns
 * `null` in standalone mode, and every API-bound caller already handles `null`
 * (`NO_API_URL_ERROR`). That is why this module owns the *one* API-URL
 * resolver — the three copies that used to live in `internal-api.ts`,
 * `server-framework.ts` and `self-assign.ts` each fell back to
 * `http://api.<ns>.svc.cluster.local`, which inside a partner's Kubernetes pod
 * resolves to nothing and produced a stream of ENOTFOUND/ECONNREFUSED noise
 * (SHO-418).
 *
 * Off the flag, behaviour is unchanged: the same env chain, and the same
 * in-cluster ClusterIP fallback for our own pods.
 */

import { existsSync } from 'fs'

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** Parse a boolean-ish env value. `undefined`/blank/anything else is false. */
export function isTruthyEnv(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

let standaloneCache: boolean | null = null

/**
 * True when this process runs in standalone mode. Read once and cached: the
 * flag decides boot-time wiring, so a mid-flight change must not half-apply.
 */
export function isStandalone(): boolean {
  if (standaloneCache === null) standaloneCache = isTruthyEnv(process.env.SHOGO_STANDALONE)
  return standaloneCache
}

/** Test seam — forget the cached flag so a test can flip `SHOGO_STANDALONE`. */
export function __resetStandaloneForTests(): void {
  standaloneCache = null
  loggedOnce.clear()
}

/**
 * True when this process is running inside Kubernetes. Used only to decide
 * whether the in-cluster ClusterIP fallback can possibly resolve.
 */
export function isInKubernetes(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KUBERNETES_SERVICE_HOST) return true
  try {
    return existsSync(SA_TOKEN_PATH)
  } catch {
    return false
  }
}

/**
 * The one API-URL resolver for every runtime.
 *
 * Order: `SHOGO_API_URL` → `API_URL` → the host of `AI_PROXY_URL` → the
 * in-cluster ClusterIP (only inside Kubernetes) → `null`.
 *
 * `null` means "there is no Shogo API to talk to". Callers must treat it as
 * "this feature is off", not as an error to retry: in standalone mode it is
 * the normal answer, and outside Kubernetes it is the honest one (the
 * ClusterIP name cannot resolve there, so returning it only bought an
 * ENOTFOUND).
 */
export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isStandalone()) return null
  if (env.SHOGO_API_URL) return env.SHOGO_API_URL
  if (env.API_URL) return env.API_URL
  const proxyUrl = env.AI_PROXY_URL
  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl)
      return `${url.protocol}//${url.host}`
    } catch {
      // Invalid URL — fall through to the cluster fallback.
    }
  }
  if (!isInKubernetes(env)) return null
  const systemNs = env.SYSTEM_NAMESPACE || 'shogo-system'
  return `http://api.${systemNs}.svc.cluster.local`
}

const loggedOnce = new Set<string>()

/**
 * Log a "this is off in standalone mode" line once per key. Callers that hit a
 * disabled path on every turn (trust refresh, capability sync, cost metrics)
 * would otherwise print a stack per call and bury the real errors.
 */
export function logStandaloneOnce(key: string, message: string): void {
  if (loggedOnce.has(key)) return
  loggedOnce.add(key)
  console.log(`[standalone] ${message}`)
}

/**
 * Log the one-line "no API configured" notice for a caller that just got
 * `null` from {@link resolveApiUrl}. In standalone mode it says the feature is
 * off; anywhere else it says the API URL is missing (a misconfiguration).
 */
export function logNoApiUrlOnce(key: string, feature: string): void {
  if (isStandalone()) {
    logStandaloneOnce(key, `${feature} disabled in standalone mode`)
    return
  }
  logStandaloneOnce(key, `${feature} disabled: no Shogo API URL configured (SHOGO_API_URL is unset)`)
}

// ---------------------------------------------------------------------------
// Model pinning — `AGENT_MODEL=<provider>:<model>`
// ---------------------------------------------------------------------------

export interface AgentModelPin {
  /** Provider the pinned model is served by (`local`, `openai`, `anthropic`, …). */
  provider: string
  /** The model id sent to that provider. */
  id: string
}

/**
 * Parse `AGENT_MODEL`. The format is `<provider>:<model>`; only the FIRST
 * colon separates them, so an id that itself contains a colon
 * (`local:qwen2.5:3b`) survives intact. A value with no colon is taken as a
 * bare model id on the `local` (OpenAI-compatible) provider.
 */
export function parseAgentModelPin(raw: string | undefined | null): AgentModelPin | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  const sep = value.indexOf(':')
  if (sep < 0) return { provider: 'local', id: value }
  const provider = value.slice(0, sep).trim()
  const id = value.slice(sep + 1).trim()
  if (!provider || !id) return null
  return { provider, id }
}

/**
 * The pinned model, when `AGENT_MODEL` is set. Every model-selection path in
 * the runtime consults this first, so one env var pins the whole process —
 * Auto tiers, the summarizer, heartbeats, subagents and the project's
 * `config.json` model alike.
 */
export function pinnedAgentModel(env: NodeJS.ProcessEnv = process.env): AgentModelPin | null {
  return parseAgentModelPin(env.AGENT_MODEL)
}

// ---------------------------------------------------------------------------
// Boot-time validation
// ---------------------------------------------------------------------------

/** Thrown at boot when standalone mode is missing required configuration. */
export class StandaloneConfigError extends Error {
  readonly missing: string[]
  constructor(missing: string[]) {
    super(
      `SHOGO_STANDALONE=1 is missing required environment: ${missing.join(', ')}. ` +
        `A standalone runtime has no Shogo API to fall back on, so every one of these must be set.`,
    )
    this.name = 'StandaloneConfigError'
    this.missing = missing
  }
}

/**
 * Env groups a provider needs before it can serve a request. Each inner array
 * is "one of these"; a group with no member set is reported as missing.
 */
function requiredProviderEnvGroups(provider: string): string[][] {
  switch (provider) {
    case 'local':
      return [['OPENAI_BASE_URL', 'LOCAL_LLM_BASE_URL']]
    case 'openai':
      return [['OPENAI_BASE_URL'], ['OPENAI_API_KEY']]
    case 'anthropic':
      return [['ANTHROPIC_API_KEY']]
    case 'google':
      return [['GOOGLE_API_KEY', 'GEMINI_API_KEY']]
    case 'openrouter':
      return [['OPENROUTER_API_KEY']]
    default:
      return []
  }
}

/**
 * Fail fast at boot when standalone mode is misconfigured. One error naming
 * every missing variable, so a partner fixes the pod spec once instead of
 * discovering them one restart at a time.
 *
 * No-op when `SHOGO_STANDALONE` is off.
 */
export function assertStandaloneEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!isStandalone()) return

  if (isTruthyEnv(env.WARM_POOL_MODE)) {
    throw new Error(
      'SHOGO_STANDALONE=1 cannot be combined with WARM_POOL_MODE=true: a standalone runtime is ' +
        'statically bound to its own workspace and is never a warm-pool pod.',
    )
  }

  const missing: string[] = []
  if (!env.RUNTIME_AUTH_SECRET?.trim()) missing.push('RUNTIME_AUTH_SECRET')

  const pin = parseAgentModelPin(env.AGENT_MODEL)
  if (!pin) {
    missing.push('AGENT_MODEL')
  } else {
    for (const group of requiredProviderEnvGroups(pin.provider)) {
      if (!group.some((name) => env[name]?.trim())) missing.push(group.join(' or '))
    }
  }

  if (missing.length > 0) throw new StandaloneConfigError(missing)
}
