// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface StopRequestConfig {
  localAgentUrl?: string | null
  projectId?: string | null
  apiBaseUrl: string
  platform: string
  getCookie?: () => string | null
  chatSessionId?: string | null
}

export interface StopRequestResult {
  url: string
  init: RequestInit
}

/**
 * Builds the URL and fetch options for a chat stop request,
 * including the correct auth credentials for the target.
 */
export function buildStopRequest(config: StopRequestConfig): StopRequestResult | null {
  const { localAgentUrl, projectId, apiBaseUrl, platform, getCookie, chatSessionId } = config

  const url = localAgentUrl
    ? `${localAgentUrl}/agent/stop`
    : projectId
      ? `${apiBaseUrl}/api/projects/${projectId}/chat/stop`
      : null

  if (!url) return null

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const body: Record<string, string> = {}
  if (chatSessionId) body.chatSessionId = chatSessionId
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }

  // Remote API requires auth credentials; local agent does not
  if (!localAgentUrl) {
    if (platform === 'web') {
      init.credentials = 'include'
    } else if (getCookie) {
      const cookie = getCookie()
      if (cookie) headers.Cookie = cookie
    }
  }

  return { url, init }
}
