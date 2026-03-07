// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared chat transport URL builder.
 *
 * Builds the chat API endpoint URL for a project. Used by both web and mobile
 * to create their DefaultChatTransport instances.
 */

import { useMemo } from 'react'

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
}: ChatTransportOptions): ChatTransportConfig | undefined {
  return useMemo(() => {
    if (!projectId && !localAgentUrl) return undefined

    return {
      api: buildChatApiUrl(apiBaseUrl, projectId, localAgentUrl),
      credentials,
      fetch: customFetch,
      headers,
    }
  }, [apiBaseUrl, projectId, localAgentUrl, credentials, customFetch, headers])
}
