// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useGitGraph Hook
 *
 * Fetches the project workspace's real git history as a DAG for the
 * GitKraken-style commit-graph view:
 * - commits with parent SHAs + ref decorations + co-authors
 * - branch + tag lists, current HEAD
 * - working-directory status (for the WIP row)
 * - lazy per-commit detail (files changed, full message, parents)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { GitStatus } from "./useCheckpoints"

export type GitRefType = "head" | "remote" | "tag" | "HEAD"

export interface GitRef {
  name: string
  type: GitRefType
}

export interface GitCoAuthor {
  name: string
  email: string
}

export interface GitGraphCommit {
  sha: string
  shortSha: string
  parents: string[]
  refs: GitRef[]
  subject: string
  body: string
  author: string
  authorEmail: string
  committer: string
  committerEmail: string
  date: string
  coAuthors: GitCoAuthor[]
}

export interface GitGraphBranch {
  name: string
  isCurrent: boolean
}

export interface GitCommitDetailFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  additions: number
  deletions: number
  oldPath?: string
}

export interface GitCommitDetail extends GitGraphCommit {
  files: GitCommitDetailFile[]
  totalAdditions: number
  totalDeletions: number
}

export interface UseGitGraphOptions {
  baseUrl?: string
  credentials?: RequestCredentials
  headers?: () => Record<string, string>
  /** Commits per page. */
  pageSize?: number
}

export interface GitGraphState {
  commits: GitGraphCommit[]
  branches: GitGraphBranch[]
  tags: string[]
  head: string | null
  currentBranch: string | null
  workingStatus: GitStatus | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  error: Error | null
  /** True when the API returned 409 for a folder-linked project. */
  disabledForExternalMode: boolean
  loadMore: () => void
  refetch: () => void
  /** Lazily fetch (and cache) full detail for one commit. */
  getCommitDetail: (sha: string) => Promise<GitCommitDetail | null>
}

export function useGitGraph(
  projectId: string | undefined,
  options?: UseGitGraphOptions,
): GitGraphState {
  const baseUrl = options?.baseUrl ?? ""
  const credentials = options?.credentials
  const extraHeaders = options?.headers
  const pageSize = options?.pageSize ?? 200

  const [commits, setCommits] = useState<GitGraphCommit[]>([])
  const [branches, setBranches] = useState<GitGraphBranch[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [head, setHead] = useState<string | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [workingStatus, setWorkingStatus] = useState<GitStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [disabledForExternalMode, setDisabledForExternalMode] = useState(false)
  const [refetchCounter, setRefetchCounter] = useState(0)

  const detailCache = useRef<Map<string, GitCommitDetail>>(new Map())

  const buildOpts = useCallback((): RequestInit => {
    const opts: RequestInit = {}
    if (credentials) opts.credentials = credentials
    if (extraHeaders) opts.headers = extraHeaders()
    return opts
  }, [credentials, extraHeaders])

  useEffect(() => {
    if (!projectId) {
      setCommits([])
      setWorkingStatus(null)
      return
    }
    let cancelled = false
    detailCache.current.clear()

    const run = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const [graphRes, statusRes] = await Promise.all([
          fetch(`${baseUrl}/api/projects/${projectId}/git/graph?limit=${pageSize}`, buildOpts()),
          fetch(`${baseUrl}/api/projects/${projectId}/git/status`, buildOpts()),
        ])
        if (cancelled) return

        if (graphRes.ok) {
          setDisabledForExternalMode(false)
          const data: any = await graphRes.json()
          const g = data.graph ?? {}
          setCommits(g.commits ?? [])
          setBranches(g.branches ?? [])
          setTags(g.tags ?? [])
          setHead(g.head ?? null)
          setCurrentBranch(g.currentBranch ?? null)
          setHasMore(Boolean(data.hasMore))
        } else if (graphRes.status === 409) {
          let code: string | undefined
          try {
            const body: any = await graphRes.json()
            code = body?.error?.code
          } catch {
            /* ignore */
          }
          setDisabledForExternalMode(code === "checkpoints_disabled_in_external_mode")
          setCommits([])
          setBranches([])
          setTags([])
          setHasMore(false)
        } else {
          setDisabledForExternalMode(false)
          setCommits([])
          setHasMore(false)
        }

        if (statusRes.ok) {
          const data: any = await statusRes.json()
          setWorkingStatus((data?.status ?? null) as GitStatus | null)
        } else {
          setWorkingStatus(null)
        }
      } catch (err) {
        if (cancelled) return
        console.error("[useGitGraph] fetch error:", err)
        setError(err instanceof Error ? err : new Error("Failed to load git graph"))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [projectId, refetchCounter, baseUrl, pageSize, buildOpts])

  const loadMore = useCallback(() => {
    if (!projectId || isLoadingMore || !hasMore) return
    let cancelled = false
    const run = async () => {
      setIsLoadingMore(true)
      try {
        const skip = commits.length
        const res = await fetch(
          `${baseUrl}/api/projects/${projectId}/git/graph?limit=${pageSize}&skip=${skip}`,
          buildOpts(),
        )
        if (cancelled || !res.ok) return
        const data: any = await res.json()
        const more: GitGraphCommit[] = data.graph?.commits ?? []
        // Skip-based paging can overlap if refs changed; de-dupe by sha.
        setCommits((prev) => {
          const seen = new Set(prev.map((c) => c.sha))
          return [...prev, ...more.filter((c) => !seen.has(c.sha))]
        })
        setHasMore(Boolean(data.hasMore))
      } catch (err) {
        console.error("[useGitGraph] loadMore error:", err)
      } finally {
        if (!cancelled) setIsLoadingMore(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [projectId, isLoadingMore, hasMore, commits.length, baseUrl, pageSize, buildOpts])

  const getCommitDetail = useCallback(
    async (sha: string): Promise<GitCommitDetail | null> => {
      if (!projectId) return null
      const cached = detailCache.current.get(sha)
      if (cached) return cached
      try {
        const res = await fetch(
          `${baseUrl}/api/projects/${projectId}/git/commit/${encodeURIComponent(sha)}`,
          buildOpts(),
        )
        if (!res.ok) return null
        const data: any = await res.json()
        const detail = (data?.commit ?? null) as GitCommitDetail | null
        if (detail) detailCache.current.set(sha, detail)
        return detail
      } catch (err) {
        console.error("[useGitGraph] getCommitDetail error:", err)
        return null
      }
    },
    [projectId, baseUrl, buildOpts],
  )

  const refetch = useCallback(() => setRefetchCounter((c) => c + 1), [])

  return useMemo(
    () => ({
      commits,
      branches,
      tags,
      head,
      currentBranch,
      workingStatus,
      isLoading,
      isLoadingMore,
      hasMore,
      error,
      disabledForExternalMode,
      loadMore,
      refetch,
      getCommitDetail,
    }),
    [
      commits,
      branches,
      tags,
      head,
      currentBranch,
      workingStatus,
      isLoading,
      isLoadingMore,
      hasMore,
      error,
      disabledForExternalMode,
      loadMore,
      refetch,
      getCommitDetail,
    ],
  )
}
