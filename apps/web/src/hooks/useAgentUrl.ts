/**
 * Resolves the agent runtime base URL.
 *
 * When a `localAgentUrl` is provided (desktop mode), it is used directly.
 * Otherwise the URL is fetched from the cloud sandbox endpoint.
 */

import { useState, useEffect, useCallback } from 'react'

export function useAgentUrl(
  projectId: string,
  localAgentUrl?: string | null,
) {
  const [agentUrl, setAgentUrl] = useState<string | null>(localAgentUrl ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (localAgentUrl) {
      setAgentUrl(localAgentUrl)
      setError(null)
      return
    }

    if (!projectId) return

    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/sandbox/url`)
        if (!res.ok) throw new Error('Agent not running')
        const data = await res.json()
        if (!cancelled) {
          setAgentUrl(data.agentUrl || data.url)
          setError(null)
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()

    return () => { cancelled = true }
  }, [projectId, localAgentUrl])

  const refetch = useCallback(async (): Promise<string> => {
    if (localAgentUrl) return localAgentUrl

    const res = await fetch(`/api/projects/${projectId}/sandbox/url`)
    if (!res.ok) throw new Error('Agent not running')
    const data = await res.json()
    const url = data.agentUrl || data.url
    setAgentUrl(url)
    return url
  }, [projectId, localAgentUrl])

  return { agentUrl, error, refetch }
}
