/**
 * useWorkspaceNavigation Hook
 * Task: task-2-2-002
 *
 * Manages navigation state for workspace, project, feature, and folder.
 * - Workspace slug stored in localStorage (persists across sessions)
 * - Project, feature, folder IDs stored in URL params (shareable)
 *
 * Features:
 * - Workspace persisted in localStorage, not URL
 * - Type-safe URL state via nuqs parseAsString
 * - Cascade clearing: changing workspace clears project+feature, changing project clears feature
 * - Clean utility functions: clearFeature, clearProject
 */

import { useQueryState, parseAsString } from "nuqs"
import { useCallback, useState, useEffect } from "react"

const WORKSPACE_STORAGE_KEY = "shogo-current-workspace"

/**
 * Return type for useWorkspaceNavigation hook
 */
export interface WorkspaceNavigationState {
  /** Current workspace slug from localStorage */
  workspaceSlug: string | null
  /** Set workspace slug (cascades to clear project, feature, and folder) */
  setWorkspaceSlug: (slug: string | null) => void
  /** Current project ID from URL */
  projectId: string | null
  /** Set project ID (cascades to clear feature) */
  setProjectId: (projectId: string | null) => Promise<URLSearchParams>
  /** Current feature ID from URL */
  featureId: string | null
  /** Set feature ID */
  setFeatureId: (featureId: string | null) => Promise<URLSearchParams>
  /** Current folder ID from URL (for All Projects page) */
  folderId: string | null
  /** Set folder ID for navigating into folders */
  setFolderId: (folderId: string | null) => Promise<URLSearchParams>
  /** Clear feature ID (keeps workspace and project) */
  clearFeature: () => Promise<URLSearchParams>
  /** Clear project ID and feature ID (keeps workspace) */
  clearProject: () => Promise<URLSearchParams>
  /** Clear folder ID (navigate to root of All Projects) */
  clearFolder: () => Promise<URLSearchParams>
}

/**
 * Hook for managing workspace navigation state.
 *
 * Workspace slug is stored in localStorage for persistence without URL clutter.
 * Uses nuqs useQueryState for URL parameters (project, feature, folder).
 *
 * Implements cascade clearing:
 * - Changing workspace clears projectId, featureId, and folderId
 * - Changing project clears featureId
 *
 * @example
 * ```tsx
 * const { workspaceSlug, setWorkspaceSlug, projectId, setProjectId, featureId } = useWorkspaceNavigation()
 *
 * // Navigate to a different workspace (clears project and feature)
 * setWorkspaceSlug('new-workspace')
 *
 * // Select a project (clears feature)
 * await setProjectId('project-123')
 *
 * // Select a feature
 * await setFeatureId('feature-456')
 * ```
 */
export function useWorkspaceNavigation(): WorkspaceNavigationState {
  // Workspace slug stored in localStorage
  const [workspaceSlug, setWorkspaceSlugState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null
    return localStorage.getItem(WORKSPACE_STORAGE_KEY)
  })

  // Listen for localStorage changes from other hook instances or tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === WORKSPACE_STORAGE_KEY) {
        setWorkspaceSlugState(e.newValue)
      }
    }

    // Custom event for same-window localStorage updates
    const handleCustomStorageChange = (e: CustomEvent<string | null>) => {
      setWorkspaceSlugState(e.detail)
    }

    window.addEventListener("storage", handleStorageChange)
    window.addEventListener("workspace-changed", handleCustomStorageChange as EventListener)

    return () => {
      window.removeEventListener("storage", handleStorageChange)
      window.removeEventListener("workspace-changed", handleCustomStorageChange as EventListener)
    }
  }, [])

  // URL state for project ID
  const [projectId, setProjectIdRaw] = useQueryState("project", parseAsString)

  // URL state for feature ID
  const [featureId, setFeatureIdRaw] = useQueryState("feature", parseAsString)

  // URL state for folder ID (All Projects page navigation)
  const [folderId, setFolderIdRaw] = useQueryState("folder", parseAsString)

  /**
   * Set workspace - cascades to clear project, feature, and folder
   */
  const setWorkspaceSlug = useCallback(
    (newSlug: string | null) => {
      // Update localStorage
      if (newSlug) {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, newSlug)
      } else {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY)
      }
      setWorkspaceSlugState(newSlug)

      // Dispatch custom event to notify other hook instances in the same window
      // (storage event only fires for other tabs/windows, not the same window)
      window.dispatchEvent(new CustomEvent("workspace-changed", { detail: newSlug }))

      // Clear URL params when workspace changes
      setProjectIdRaw(null)
      setFeatureIdRaw(null)
      setFolderIdRaw(null)
    },
    [setProjectIdRaw, setFeatureIdRaw, setFolderIdRaw]
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

  /**
   * Set folder ID - no cascade (stays within same workspace)
   */
  const setFolderId = useCallback(
    async (newFolderId: string | null): Promise<URLSearchParams> => {
      return setFolderIdRaw(newFolderId)
    },
    [setFolderIdRaw]
  )

  /**
   * Clear folder ID (navigate to root of All Projects)
   */
  const clearFolder = useCallback(async (): Promise<URLSearchParams> => {
    return setFolderIdRaw(null)
  }, [setFolderIdRaw])

  return {
    workspaceSlug,
    setWorkspaceSlug,
    projectId,
    setProjectId,
    featureId,
    setFeatureId,
    folderId,
    setFolderId,
    clearFeature,
    clearProject,
    clearFolder,
  }
}
