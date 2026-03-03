/**
 * useCheckpoints Hook
 *
 * Provides checkpoint data and operations for project version control:
 * - List checkpoints for a project
 * - Create new checkpoints
 * - Rollback to previous checkpoints
 * - Get checkpoint diffs
 *
 * Uses the SDK HttpClient (via useSDKHttp) for all API calls, ensuring
 * correct base URL and auth in both dev and production.
 */

import { useState, useEffect, useCallback } from "react"
import { useSDKHttp } from "../domain"

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
  checkpoints: Checkpoint[]
  gitStatus: GitStatus | null
  isLoading: boolean
  isMutating: boolean
  error: Error | null
  createCheckpoint: (options: {
    message: string
    name?: string
    description?: string
    includeDatabase?: boolean
  }) => Promise<Checkpoint | null>
  rollback: (checkpointId: string, includeDatabase?: boolean) => Promise<boolean>
  getDiff: (checkpointId: string) => Promise<CheckpointDiff | null>
  refetch: () => void
}

interface CheckpointsApiResponse {
  ok?: boolean
  checkpoints?: Array<Checkpoint & { message?: string }>
  hasMore?: boolean
}

interface CheckpointCreateResponse {
  ok?: boolean
  checkpoint?: Checkpoint
}

interface GitStatusResponse extends GitStatus {
  ok?: boolean
}

/**
 * Hook for managing project checkpoints (version control).
 *
 * @example
 * ```tsx
 * const { checkpoints, createCheckpoint, rollback } = useCheckpoints(projectId)
 * await createCheckpoint({ message: "Added authentication" })
 * await rollback(checkpointId)
 * ```
 */
export function useCheckpoints(projectId: string | undefined): CheckpointsState {
  const http = useSDKHttp()
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refetchCounter, setRefetchCounter] = useState(0)

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
        const [checkpointsRes, statusRes] = await Promise.allSettled([
          http.get<CheckpointsApiResponse>(`/api/projects/${projectId}/checkpoints`),
          http.get<GitStatusResponse>(`/api/projects/${projectId}/git/status`),
        ])

        if (cancelled) return

        if (checkpointsRes.status === "fulfilled" && checkpointsRes.value.data?.checkpoints) {
          const mapped = checkpointsRes.value.data.checkpoints.map((cp) => ({
            ...cp,
            commitMessage: cp.message || cp.commitMessage,
          }))
          setCheckpoints(mapped)
        } else {
          setCheckpoints([])
        }

        if (statusRes.status === "fulfilled" && statusRes.value.data) {
          setGitStatus(statusRes.value.data as GitStatus)
        } else {
          setGitStatus(null)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error("Failed to fetch checkpoints"))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchCheckpoints()
    return () => { cancelled = true }
  }, [projectId, http, refetchCounter])

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
        const res = await http.post<CheckpointCreateResponse>(
          `/api/projects/${projectId}/checkpoints`,
          options
        )

        if (!res.data?.ok || !res.data.checkpoint) {
          throw new Error("Failed to create checkpoint")
        }

        setCheckpoints((prev) => [res.data!.checkpoint!, ...prev])
        return res.data.checkpoint
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to create checkpoint"))
        return null
      } finally {
        setIsMutating(false)
      }
    },
    [projectId, http]
  )

  const rollback = useCallback(
    async (checkpointId: string, includeDatabase?: boolean): Promise<boolean> => {
      if (!projectId) return false

      setIsMutating(true)
      setError(null)

      try {
        const res = await http.post<{ ok?: boolean }>(
          `/api/projects/${projectId}/checkpoints/${checkpointId}/rollback`,
          { includeDatabase }
        )

        if (!res.data?.ok) {
          throw new Error("Failed to rollback")
        }

        setRefetchCounter((c) => c + 1)
        return true
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to rollback"))
        return false
      } finally {
        setIsMutating(false)
      }
    },
    [projectId, http]
  )

  const getDiff = useCallback(
    async (checkpointId: string): Promise<CheckpointDiff | null> => {
      if (!projectId) return null

      try {
        const res = await http.get<CheckpointDiff>(
          `/api/projects/${projectId}/checkpoints/${checkpointId}/diff`
        )
        return res.data ?? null
      } catch {
        return null
      }
    },
    [projectId, http]
  )

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
