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
  options?: { credentials?: RequestCredentials; localAgentUrl?: string | null },
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

    ;(async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/projects/${projectId}/sandbox/url`, {
          credentials: options?.credentials,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('Failed to get sandbox URL')
        const data = await res.json()
        if (!controller.signal.aborted) {
          setAgentUrl(data.agentUrl || data.url || null)
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
