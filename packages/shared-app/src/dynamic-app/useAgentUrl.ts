// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useAgentUrl
 *
 * Resolves the agent runtime URL for a project by calling the sandbox/url endpoint.
 * Used by both the chat transport and the dynamic app SSE stream.
 */

import { useState, useEffect, useRef } from 'react'

export function useAgentUrl(
  apiBaseUrl: string,
  projectId: string | undefined,
  options?: {
    credentials?: RequestCredentials
    localAgentUrl?: string | null
    headers?: () => Record<string, string>
    fetch?: typeof globalThis.fetch
  },
) {
  const [agentUrl, setAgentUrl] = useState<string | null>(options?.localAgentUrl ?? null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (options?.localAgentUrl) {
      setAgentUrl(options.localAgentUrl)
      setError(null)
      return
    }

    if (!projectId) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const doFetch = options?.fetch ?? fetch

    ;(async () => {
      try {
        const res = await doFetch(`${apiBaseUrl}/api/projects/${projectId}/sandbox/url`, {
          credentials: options?.credentials,
          headers: options?.headers?.(),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('Failed to get sandbox URL')
        const data = await res.json()
        let resolved = data.agentUrl || data.url || null

        // The server returns agent URLs relative to itself (localhost).
        // On mobile devices localhost refers to the device, not the dev
        // machine, so rewrite the host to match apiBaseUrl.
        if (resolved) {
          try {
            const agentParsed = new URL(resolved)
            const apiParsed = new URL(apiBaseUrl)
            if (
              agentParsed.hostname === 'localhost' &&
              apiParsed.hostname !== 'localhost'
            ) {
              agentParsed.hostname = apiParsed.hostname
              resolved = agentParsed.origin
            }
          } catch {}
        }

        if (!controller.signal.aborted) {
          setAgentUrl(resolved)
          setError(null)
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return
        if (!controller.signal.aborted) setError(err.message)
      }
    })()

    return () => { controller.abort() }
  }, [apiBaseUrl, projectId, options?.localAgentUrl, options?.credentials])

  return { agentUrl, error }
}
