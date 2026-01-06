/**
 * useWorkspaceNavigation Hook
 * Task: task-2-2-002
 *
 * Manages URL state for workspace navigation using nuqs.
 * URL params: ?org={slug}&project={id}&feature={id}
 *
 * Features:
 * - Type-safe URL state via nuqs parseAsString
 * - Cascade clearing: changing org clears project+feature, changing project clears feature
 * - Clean utility functions: clearFeature, clearProject
 *
 * Per design decision design-2-2-url-state:
 * - URL is source of truth for navigation state
 * - Uses parseAsString for all params
 * - Org uses slug (human-readable), project/feature use IDs
 */

import { useQueryState, parseAsString } from "nuqs"
import { useCallback } from "react"

/**
 * Return type for useWorkspaceNavigation hook
 */
export interface WorkspaceNavigationState {
  /** Current organization slug from URL */
  org: string | null
  /** Set organization slug (cascades to clear project and feature) */
  setOrg: (org: string | null) => Promise<URLSearchParams>
  /** Current project ID from URL */
  projectId: string | null
  /** Set project ID (cascades to clear feature) */
  setProjectId: (projectId: string | null) => Promise<URLSearchParams>
  /** Current feature ID from URL */
  featureId: string | null
  /** Set feature ID */
  setFeatureId: (featureId: string | null) => Promise<URLSearchParams>
  /** Clear feature ID (keeps org and project) */
  clearFeature: () => Promise<URLSearchParams>
  /** Clear project ID and feature ID (keeps org) */
  clearProject: () => Promise<URLSearchParams>
}

/**
 * Hook for managing workspace navigation URL state.
 *
 * Uses nuqs useQueryState for type-safe URL parameter management.
 * Implements cascade clearing per design-2-2-url-state:
 * - Changing org clears projectId and featureId
 * - Changing project clears featureId
 *
 * @example
 * ```tsx
 * const { org, setOrg, projectId, setProjectId, featureId } = useWorkspaceNavigation()
 *
 * // Navigate to a different org (clears project and feature)
 * await setOrg('new-org')
 *
 * // Select a project (clears feature)
 * await setProjectId('project-123')
 *
 * // Select a feature
 * await setFeatureId('feature-456')
 * ```
 */
export function useWorkspaceNavigation(): WorkspaceNavigationState {
  // URL state for organization slug
  const [org, setOrgRaw] = useQueryState("org", parseAsString)

  // URL state for project ID
  const [projectId, setProjectIdRaw] = useQueryState("project", parseAsString)

  // URL state for feature ID
  const [featureId, setFeatureIdRaw] = useQueryState("feature", parseAsString)

  /**
   * Set organization - cascades to clear project and feature
   */
  const setOrg = useCallback(
    async (newOrg: string | null): Promise<URLSearchParams> => {
      // Clear project and feature when org changes
      await setProjectIdRaw(null)
      await setFeatureIdRaw(null)
      return setOrgRaw(newOrg)
    },
    [setOrgRaw, setProjectIdRaw, setFeatureIdRaw]
  )

  /**
   * Set project ID - cascades to clear feature
   */
  const setProjectId = useCallback(
    async (newProjectId: string | null): Promise<URLSearchParams> => {
      // Clear feature when project changes
      await setFeatureIdRaw(null)
      return setProjectIdRaw(newProjectId)
    },
    [setProjectIdRaw, setFeatureIdRaw]
  )

  /**
   * Set feature ID - no cascade
   */
  const setFeatureId = useCallback(
    async (newFeatureId: string | null): Promise<URLSearchParams> => {
      return setFeatureIdRaw(newFeatureId)
    },
    [setFeatureIdRaw]
  )

  /**
   * Clear feature ID only
   */
  const clearFeature = useCallback(async (): Promise<URLSearchParams> => {
    return setFeatureIdRaw(null)
  }, [setFeatureIdRaw])

  /**
   * Clear project ID and feature ID
   */
  const clearProject = useCallback(async (): Promise<URLSearchParams> => {
    await setFeatureIdRaw(null)
    return setProjectIdRaw(null)
  }, [setProjectIdRaw, setFeatureIdRaw])

  return {
    org,
    setOrg,
    projectId,
    setProjectId,
    featureId,
    setFeatureId,
    clearFeature,
    clearProject,
  }
}
