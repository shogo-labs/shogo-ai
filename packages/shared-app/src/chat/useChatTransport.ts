// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared chat transport URL builder.
 *
 * Builds the chat API endpoint URL for a project. Used by both web and mobile
 * to create their DefaultChatTransport instances.
 */

import { useMemo } from 'react'
import { createAutoResumingFetch } from './auto-resuming-fetch'

export interface ChatTransportOptions {
  /** API base URL (e.g., "http://localhost:8002" or "" for same-origin) */
  apiBaseUrl?: string
  /** Project ID for routing to the correct chat endpoint */
  projectId: string | undefined
  /** Direct agent URL for local development (bypasses API proxy) */
  localAgentUrl?: string | null
  /** Fetch credentials mode */
  credentials?: RequestCredentials
  /** Custom fetch implementation (e.g., expo/fetch for React Native streaming) */
  fetch?: typeof globalThis.fetch
  /** Extra headers to include with every request (e.g. Cookie for native auth) */
  headers?: Record<string, string> | (() => Record<string, string>)
  /**
   * Chat-session id sent as `X-Chat-Session-Id` on every chat POST. The
   * server uses it to key the proxy billing session by
   * `(projectId, chatSessionId)` so concurrent chat panels on the same
   * project bill independently. Optional — omit on the very first turn of
   * a brand-new session (the server falls back to a legacy projectId-only
   * billing-session key for that one turn).
   */
  chatSessionId?: string | null
  /**
   * When true (default) the chat fetch is wrapped with auto-resume so a
   * mid-turn disconnect transparently reconnects via `?fromSeq=N` instead
   * of leaving the UI stuck on a half-rendered message. Set to false to
   * opt out (e.g. for legacy environments without the durable runtime).
   */
  durableResume?: boolean
}

export interface ChatTransportConfig {
  api: string
  credentials?: RequestCredentials
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string> | (() => Record<string, string>)
}

/**
 * Build the chat API endpoint URL for a given project.
 */
export function buildChatApiUrl(
  apiBaseUrl: string,
  projectId: string | undefined,
  localAgentUrl?: string | null,
): string {
  if (localAgentUrl) return `${localAgentUrl}/agent/chat`
  if (projectId) return `${apiBaseUrl}/api/projects/${projectId}/chat`
  return `${apiBaseUrl}/api/chat`
}

/**
 * Build the read-only durable-turn snapshot URL for a given chat session.
 *
 * Used by the client to ask the runtime "is there a live turn buffered for
 * this session?" *before* deciding whether to attach to /stream. Without
 * this probe we'd fire `useChat({ resume: true })` blindly on every mount
 * and the server logs would fill up with orphan
 * `[AgentChat] Stream reconnect ... snapshot=none` lines (and, worse, the
 * resume call would race the /chat-messages history fetch — see
 * `chat-load-decision.ts` for the regression that motivated probing).
 *
 * Mirrors `defaultBuildResumeUrl` in `auto-resuming-fetch.ts` so all three
 * URLs (post / resume / turn) share the same base path.
 */
export function buildChatTurnUrl(
  apiBaseUrl: string,
  projectId: string | undefined,
  localAgentUrl: string | null | undefined,
  chatSessionId: string,
): string {
  const base = buildChatApiUrl(apiBaseUrl, projectId, localAgentUrl).replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(chatSessionId)}/turn`
}

/**
 * Hook that returns a memoized chat transport config for DefaultChatTransport.
 */
export function useChatTransportConfig({
  apiBaseUrl = '',
  projectId,
  localAgentUrl,
  credentials,
  fetch: customFetch,
  headers,
  chatSessionId,
  durableResume = true,
}: ChatTransportOptions): ChatTransportConfig | undefined {
  return useMemo(() => {
    if (!projectId && !localAgentUrl) return undefined

    const baseFetch = customFetch ?? globalThis.fetch
    const fetch = durableResume
      ? createAutoResumingFetch(baseFetch.bind(globalThis))
      : customFetch

    // Compose `headers` so the caller-provided headers (cookies, auth) and
    // the chat-session header are both forwarded. The AI SDK accepts either
    // a static record or a thunk; collapse both forms here.
    const composedHeaders: ChatTransportConfig['headers'] | undefined =
      chatSessionId
        ? () => {
            const base = typeof headers === 'function' ? headers() : headers ?? {}
            return { ...base, 'X-Chat-Session-Id': chatSessionId }
          }
        : headers

    return {
      api: buildChatApiUrl(apiBaseUrl, projectId, localAgentUrl),
      credentials,
      fetch,
      headers: composedHeaders,
    }
  }, [apiBaseUrl, projectId, localAgentUrl, credentials, customFetch, headers, chatSessionId, durableResume])
}
