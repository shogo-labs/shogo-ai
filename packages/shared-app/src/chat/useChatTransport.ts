// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * Hook that returns a memoized chat transport config for DefaultChatTransport.
 */
export function useChatTransportConfig({
  apiBaseUrl = '',
  projectId,
  localAgentUrl,
  credentials,
  fetch: customFetch,
  headers,
  durableResume = true,
}: ChatTransportOptions): ChatTransportConfig | undefined {
  return useMemo(() => {
    if (!projectId && !localAgentUrl) return undefined

    const baseFetch = customFetch ?? globalThis.fetch
    const fetch = durableResume
      ? createAutoResumingFetch(baseFetch.bind(globalThis))
      : customFetch

    return {
      api: buildChatApiUrl(apiBaseUrl, projectId, localAgentUrl),
      credentials,
      fetch,
      headers,
    }
  }, [apiBaseUrl, projectId, localAgentUrl, credentials, customFetch, headers, durableResume])
}
