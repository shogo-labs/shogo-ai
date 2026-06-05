// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * usePublishState Hook
 *
 * Fetches a project's current publish state (`GET /api/projects/:id/publish`)
 * so the commit graph can resolve "what's live" git-natively and show the live
 * URL / re-deploy affordances:
 * - `subdomain` + `publishedAt` for the live banner / "View live" link
 * - `publishedCommitSha` as a fallback when the `published/<subdomain>` pointer
 *   tag isn't in the loaded page of the graph
 *
 * Mirrors the option shape of {@link useGitGraph}/useCheckpoints (baseUrl +
 * credentials + headers) so the same call works on web (cookies) and native
 * (explicit Cookie header).
 */

import { useCallback, useEffect, useMemo, useState } from "react"

export interface UsePublishStateOptions {
  baseUrl?: string
  credentials?: RequestCredentials
  headers?: () => Record<string, string>
}

export interface PublishState {
  /** Published subdomain, or null when the project isn't published. */
  subdomain: string | null
  publishedAt: number | null
  accessLevel: string | null
  /** Commit the durable repo recorded as live (fallback for the live marker). */
  publishedCommitSha: string | null
  /** The history tag written for the most recent deploy (`publish/<sub>/<ts>`). */
  publishedTag: string | null
  isPublished: boolean
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function usePublishState(
  projectId: string | undefined,
  options?: UsePublishStateOptions,
): PublishState {
  const baseUrl = options?.baseUrl ?? ""
  const credentials = options?.credentials
  const extraHeaders = options?.headers

  const [subdomain, setSubdomain] = useState<string | null>(null)
  const [publishedAt, setPublishedAt] = useState<number | null>(null)
  const [accessLevel, setAccessLevel] = useState<string | null>(null)
  const [publishedCommitSha, setPublishedCommitSha] = useState<string | null>(null)
  const [publishedTag, setPublishedTag] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refetchCounter, setRefetchCounter] = useState(0)

  const buildOpts = useCallback((): RequestInit => {
    const opts: RequestInit = {}
    if (credentials) opts.credentials = credentials
    if (extraHeaders) opts.headers = extraHeaders()
    return opts
  }, [credentials, extraHeaders])

  useEffect(() => {
    if (!projectId) {
      setSubdomain(null)
      return
    }
    let cancelled = false
    const run = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch(`${baseUrl}/api/projects/${projectId}/publish`, buildOpts())
        if (cancelled) return
        if (res.ok) {
          const data: any = await res.json()
          setSubdomain(data?.subdomain ?? null)
          setPublishedAt(typeof data?.publishedAt === "number" ? data.publishedAt : null)
          setAccessLevel(data?.accessLevel ?? null)
          setPublishedCommitSha(data?.publishedCommitSha ?? null)
          setPublishedTag(data?.publishedTag ?? null)
        } else {
          setSubdomain(null)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error("Failed to load publish state"))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [projectId, refetchCounter, baseUrl, buildOpts])

  const refetch = useCallback(() => setRefetchCounter((c) => c + 1), [])

  return useMemo(
    () => ({
      subdomain,
      publishedAt,
      accessLevel,
      publishedCommitSha,
      publishedTag,
      isPublished: !!subdomain,
      isLoading,
      error,
      refetch,
    }),
    [subdomain, publishedAt, accessLevel, publishedCommitSha, publishedTag, isLoading, error, refetch],
  )
}
