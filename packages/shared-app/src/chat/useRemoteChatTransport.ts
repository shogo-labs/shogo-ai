// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote chat transport for controlling agents on remote Shogo instances.
 *
 * Routes chat messages through the cloud instance proxy tunnel instead
 * of directly to a project or local agent URL. This lets ChatPanel
 * work unchanged with remote instances.
 */

import { useMemo } from 'react'
import type { ChatTransportConfig } from './useChatTransport'

export interface RemoteChatTransportOptions {
  apiBaseUrl?: string
  instanceId: string
  credentials?: RequestCredentials
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string> | (() => Record<string, string>)
}

/**
 * Build the chat API URL that proxies through the instance tunnel.
 * The cloud proxy streams the request to the local instance's /agent/chat.
 */
export function buildRemoteChatApiUrl(
  apiBaseUrl: string,
  instanceId: string,
): string {
  return `${apiBaseUrl}/api/instances/${instanceId}/proxy/stream`
}

/**
 * Hook that returns a memoized chat transport config for remote instances.
 * Used by ChatPanel to send messages through the cloud tunnel proxy.
 */
export function useRemoteChatTransportConfig({
  apiBaseUrl = '',
  instanceId,
  credentials,
  fetch: customFetch,
  headers,
}: RemoteChatTransportOptions): ChatTransportConfig | undefined {
  return useMemo(() => {
    if (!instanceId) return undefined

    return {
      api: buildRemoteChatApiUrl(apiBaseUrl, instanceId),
      credentials,
      fetch: customFetch,
      headers,
    }
  }, [apiBaseUrl, instanceId, credentials, customFetch, headers])
}
