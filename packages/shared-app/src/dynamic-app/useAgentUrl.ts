// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useAgentUrl
 *
 * Resolves the agent runtime URL and preview URL for a project by calling
 * the sandbox/url endpoint. Returns three values:
 *   agentUrl      – proxied agent runtime (for chat, SSE stream, capabilities)
 *   previewUrl    – Vite dev server or published app URL (for APP project iframe)
 *   canvasBaseUrl – direct runtime URL for the canvas iframe; fetch('/api/...')
 *                   resolves same-origin so no proxy rewriting is needed.
 */

import { useState, useEffect, useRef } from 'react'

function rewriteLocalhostUrl(url: string, apiBaseUrl: string): string {
  try {
    const parsed = new URL(url)
    const apiParsed = new URL(apiBaseUrl)
    if (parsed.hostname === 'localhost' && apiParsed.hostname !== 'localhost') {
      parsed.hostname = apiParsed.hostname
      return parsed.href.replace(/\/+$/, '')
    }
  } catch {}
  return url
}

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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [canvasBaseUrl, setCanvasBaseUrl] = useState<string | null>(null)
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

        let resolvedAgent = data.agentUrl || data.url || null
        let resolvedPreview = data.url || null
        let resolvedCanvas = data.canvasBaseUrl || resolvedAgent || null

        if (resolvedAgent) {
          resolvedAgent = rewriteLocalhostUrl(resolvedAgent, apiBaseUrl)
        }
        if (resolvedPreview) {
          resolvedPreview = rewriteLocalhostUrl(resolvedPreview, apiBaseUrl)
        }
        if (resolvedCanvas) {
          resolvedCanvas = rewriteLocalhostUrl(resolvedCanvas, apiBaseUrl)
        }

        if (!controller.signal.aborted) {
          setAgentUrl(resolvedAgent)
          setPreviewUrl(resolvedPreview)
          setCanvasBaseUrl(resolvedCanvas)
          setError(null)
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return
        if (!controller.signal.aborted) setError(err.message)
      }
    })()

    return () => { controller.abort() }
  }, [apiBaseUrl, projectId, options?.localAgentUrl, options?.credentials])

  return { agentUrl, previewUrl, canvasBaseUrl, error }
}
