// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useCheckpoints Hook
 *
 * Provides checkpoint data and operations for project version control:
 * - List checkpoints for a project
 * - Create new checkpoints
 * - Rollback to previous checkpoints
 * - Get checkpoint diffs
 */

import { useState, useEffect, useCallback, useMemo } from "react"

/**
 * Checkpoint data from the API
 */
export interface Checkpoint {
  id: string
  projectId: string
  name: string | null
  description: string | null
  commitSha: string
  commitMessage: string
  branch: string
  includesDb: boolean
  filesChanged: number
  additions: number
  deletions: number
  isAutomatic: boolean
  createdBy: string | null
  createdAt: string
}

/**
 * Git status for a project
 */
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  headSha: string | null
  staged: string[]
  unstaged: string[]
  untracked: string[]
  hasChanges: boolean
}

/**
 * Diff information between checkpoints
 */
export interface CheckpointDiff {
  files: Array<{
    path: string
    status: 'added' | 'modified' | 'deleted'
    additions: number
    deletions: number
  }>
  stats: {
    filesChanged: number
    additions: number
    deletions: number
  }
}

/**
 * Return type for useCheckpoints hook
 */
export interface CheckpointsState {
  /** List of checkpoints for the project */
  checkpoints: Checkpoint[]
  /** Git status for the project */
  gitStatus: GitStatus | null
  /** Whether data is loading */
  isLoading: boolean
  /** Whether a mutation is in progress */
  isMutating: boolean
  /** Error state */
  error: Error | null
  /** Create a new checkpoint */
  createCheckpoint: (options: {
    message: string
    name?: string
    description?: string
    includeDatabase?: boolean
  }) => Promise<Checkpoint | null>
  /** Rollback to a checkpoint */
  rollback: (checkpointId: string, includeDatabase?: boolean) => Promise<boolean>
  /** Get diff for a checkpoint */
  getDiff: (checkpointId: string) => Promise<CheckpointDiff | null>
  /** Refetch checkpoints */
  refetch: () => void
}

export interface UseCheckpointsOptions {
  baseUrl?: string
  credentials?: RequestCredentials
  headers?: () => Record<string, string>
}

/**
 * Hook for managing project checkpoints (version control).
 *
 * @param projectId - The project to manage checkpoints for
 * @param options - Optional config for API base URL, credentials, and headers (needed on native)
 *
 * @example
 * ```tsx
 * const { checkpoints, createCheckpoint, rollback, isLoading } = useCheckpoints(projectId)
 *
 * // Create a checkpoint
 * await createCheckpoint({ message: "Added authentication" })
 *
 * // Rollback to a previous checkpoint
 * await rollback(checkpointId)
 * ```
 */
export function useCheckpoints(projectId: string | undefined, options?: UseCheckpointsOptions): CheckpointsState {
  const baseUrl = options?.baseUrl ?? ''
  const credentials = options?.credentials
  const extraHeaders = options?.headers
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refetchCounter, setRefetchCounter] = useState(0)

  // Fetch checkpoints
  useEffect(() => {
    if (!projectId) {
      setCheckpoints([])
      setGitStatus(null)
      return
    }

    let cancelled = false

    const fetchCheckpoints = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const fetchOpts: RequestInit = {}
        if (credentials) fetchOpts.credentials = credentials
        if (extraHeaders) {
          fetchOpts.headers = extraHeaders()
        }

        const [checkpointsRes, statusRes] = await Promise.all([
          fetch(`${baseUrl}/api/projects/${projectId}/checkpoints`, fetchOpts),
          fetch(`${baseUrl}/api/projects/${projectId}/git/status`, fetchOpts),
        ])

        if (cancelled) return

        if (checkpointsRes.ok) {
          const data: any = await checkpointsRes.json()
          const mappedCheckpoints = (data.checkpoints || []).map((cp: any) => ({
            ...cp,
            commitMessage: cp.message || cp.commitMessage,
          }))
          setCheckpoints(mappedCheckpoints)
        } else {
          // Checkpoints endpoint may not exist if no git repo yet
          setCheckpoints([])
        }

        if (statusRes.ok) {
          const data: any = await statusRes.json()
          setGitStatus(data as GitStatus)
        } else {
          setGitStatus(null)
        }
      } catch (err) {
        if (cancelled) return
        console.error("[useCheckpoints] Error fetching checkpoints:", err)
        setError(err instanceof Error ? err : new Error("Failed to fetch checkpoints"))
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    fetchCheckpoints()

    return () => {
      cancelled = true
    }
  }, [projectId, refetchCounter, baseUrl, credentials, extraHeaders])

  // Create checkpoint
  const createCheckpoint = useCallback(
    async (options: {
      message: string
      name?: string
      description?: string
      includeDatabase?: boolean
    }): Promise<Checkpoint | null> => {
      if (!projectId) return null

      setIsMutating(true)
      setError(null)

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (extraHeaders) Object.assign(headers, extraHeaders())
        const response = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints`, {
          method: "POST",
          headers,
          body: JSON.stringify(options),
          ...(credentials ? { credentials } : {}),
        })

        if (!response.ok) {
          const errorData: any = await response.json()
          throw new Error(errorData.error?.message || "Failed to create checkpoint")
        }

        const data: any = await response.json()
        setCheckpoints((prev) => [data.checkpoint, ...prev])
        return data.checkpoint
      } catch (err) {
        console.error("[useCheckpoints] Error creating checkpoint:", err)
        setError(err instanceof Error ? err : new Error("Failed to create checkpoint"))
        return null
      } finally {
        setIsMutating(false)
      }
    },
    [projectId, baseUrl, credentials, extraHeaders]
  )

  // Rollback to checkpoint
  const rollback = useCallback(
    async (checkpointId: string, includeDatabase?: boolean): Promise<boolean> => {
      if (!projectId) return false

      setIsMutating(true)
      setError(null)

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (extraHeaders) Object.assign(headers, extraHeaders())
        const response = await fetch(
          `${baseUrl}/api/projects/${projectId}/checkpoints/${checkpointId}/rollback`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ includeDatabase }),
            ...(credentials ? { credentials } : {}),
          }
        )

        if (!response.ok) {
          const errorData: any = await response.json()
          throw new Error(errorData.error?.message || "Failed to rollback")
        }

        // Refetch checkpoints after rollback
        setRefetchCounter((c) => c + 1)
        
        return true
      } catch (err) {
        console.error("[useCheckpoints] Error rolling back:", err)
        setError(err instanceof Error ? err : new Error("Failed to rollback"))
        return false
      } finally {
        setIsMutating(false)
      }
    },
    [projectId, baseUrl, credentials, extraHeaders]
  )

  // Get diff for checkpoint
  const getDiff = useCallback(
    async (checkpointId: string): Promise<CheckpointDiff | null> => {
      if (!projectId) return null

      try {
        const fetchOpts: RequestInit = {}
        if (credentials) fetchOpts.credentials = credentials
        if (extraHeaders) fetchOpts.headers = extraHeaders()
        const response = await fetch(
          `${baseUrl}/api/projects/${projectId}/checkpoints/${checkpointId}/diff`,
          fetchOpts,
        )

        if (!response.ok) {
          return null
        }

        const data: any = await response.json()
        return data as CheckpointDiff
      } catch (err) {
        console.error("[useCheckpoints] Error getting diff:", err)
        return null
      }
    },
    [projectId, baseUrl, credentials, extraHeaders]
  )

  // Refetch function
  const refetch = useCallback(() => {
    setRefetchCounter((c) => c + 1)
  }, [])

  return {
    checkpoints,
    gitStatus,
    isLoading,
    isMutating,
    error,
    createCheckpoint,
    rollback,
    getDiff,
    refetch,
  }
}
