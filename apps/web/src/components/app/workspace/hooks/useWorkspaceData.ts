/**
 * useWorkspaceData Hook
 * Task: task-2-2-002
 *
 * Combines URL state with SDK domain queries to provide workspace data.
 * Uses useWorkspaceNavigation() + SDK store to derive the complete workspace context.
 *
 * Per design decision design-2-2-data-flow:
 * - Components receive derived data, don't call stores directly
 * - workspaces fetched from SDK (store.workspaceCollection)
 * - projects fetched from SDK (store.projectCollection)
 * - features from SDK (store.featureSessionCollection)
 * - features grouped by StatusToPhase map into featuresByPhase
 *
 * Note: This hook triggers API reload when userId/workspaceId changes.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useSDKDomain } from "../../../../contexts/DomainProvider"
import { useWorkspaceNavigation } from "./useWorkspaceNavigation"
import { useSession } from "../../../../auth/client"
import type { IDomainStore } from "../../../../generated/domain"

/**
 * Global auto-selection state to prevent multiple hook instances from
 * all trying to auto-select simultaneously. This is necessary because
 * useWorkspaceData() is used by 15+ components, and each would otherwise
 * independently attempt auto-selection, causing log spam and wasted renders.
 */
const autoSelectState = {
  /** The workspace slug that was auto-selected */
  selectedSlug: null as string | null,
  /** The user ID for which auto-selection was performed */
  forUserId: null as string | null,
  /** Timestamp of last auto-selection to allow re-selection after user change */
  timestamp: 0,
}

/**
 * Phase type for feature grouping - matches FeatureSession status values
 */
export type Phase =
  | "discovery"
  | "analysis"
  | "classification"
  | "design"
  | "spec"
  | "testing"
  | "implementation"
  | "complete"

/**
 * All phases in the platform features workflow
 * Matches the status values in FeatureSession schema
 */
export const PHASES: Phase[] = [
  "discovery",
  "analysis",
  "classification",
  "design",
  "spec",
  "testing",
  "implementation",
  "complete",
]

/**
 * Return type for useWorkspaceData hook
 */
export interface WorkspaceDataState {
  /** Workspaces the current user has access to */
  workspaces: any[]
  /** Currently selected workspace (by slug) */
  currentWorkspace: any | undefined
  /** Current user's role in the current workspace */
  currentWorkspaceRole: "owner" | "admin" | "member" | "viewer" | undefined
  /** Projects for the current workspace */
  projects: any[]
  /** Currently selected project (by ID) */
  currentProject: any | undefined
  /** Folders for the current workspace */
  folders: any[]
  /** Currently selected folder (by ID from URL) */
  currentFolder: any | undefined
  /** Breadcrumb path to current folder (ancestor chain from root) */
  folderBreadcrumbs: any[]
  /** Features for the current project */
  features: any[]
  /** Currently selected feature (by ID) */
  currentFeature: any | undefined
  /** Features grouped by phase */
  featuresByPhase: Record<string, any[]>
  /** Set of starred project IDs for the current user */
  starredProjectIds: Set<string>
  /** Starred projects with full project data (across all workspaces) */
  starredProjects: any[]
  /** Workspaces where user is a member but not the owner */
  sharedWorkspaces: any[]
  /** Projects from shared workspaces */
  sharedProjects: any[]
  /** Loading state */
  isLoading: boolean
  /** Function to refetch workspaces (call after creating workspace or signup) */
  refetchWorkspaces: () => void
  /** Function to refetch projects (call after creating project) */
  refetchProjects: () => void
  /** Function to refetch folders (call after creating/deleting folder) */
  refetchFolders: () => void
  /** Function to refetch starred projects */
  refetchStarredProjects: () => void
  /** Toggle star status for a project */
  toggleStarProject: (projectId: string, workspaceId: string) => Promise<boolean>
  /** Check if a project is starred */
  isProjectStarred: (projectId: string) => boolean
}

/**
 * Hook for accessing workspace data derived from URL state and API/domain queries.
 *
 * Combines:
 * - useWorkspaceNavigation() for URL state (workspace slug, project ID, feature ID)
 * - useSession() for auth state
 * - useSDKDomain() for all data (workspaces, projects, features, etc.)
 *
 * @example
 * ```tsx
 * const {
 *   workspaces,
 *   currentWorkspace,
 *   projects,
 *   currentProject,
 *   features,
 *   currentFeature,
 *   featuresByPhase,
 *   isLoading
 * } = useWorkspaceData()
 *
 * // Display features grouped by phase
 * {PHASES.map(phase => (
 *   <FeatureGroup key={phase} phase={phase} features={featuresByPhase[phase]} />
 * ))}
 * ```
 */
export function useWorkspaceData(): WorkspaceDataState {
  // Get URL state and setters
  const { workspaceSlug, projectId, featureId, folderId, setWorkspaceSlug } = useWorkspaceNavigation()

  // Get auth session from Better Auth
  const { data: session, isPending: isSessionLoading } = useSession()

  // Get SDK domain store (replaces state-api domains)
  const store = useSDKDomain() as IDomainStore

  // State for tracking loading and refetch
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true)
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)
  const [isLoadingFolders, setIsLoadingFolders] = useState(false)
  const [isLoadingStarred, setIsLoadingStarred] = useState(false)
  const [workspacesRefetchCounter, setWorkspacesRefetchCounter] = useState(0)
  const [projectsRefetchCounter, setProjectsRefetchCounter] = useState(0)
  const [foldersRefetchCounter, setFoldersRefetchCounter] = useState(0)
  const [starredRefetchCounter, setStarredRefetchCounter] = useState(0)

  // User ID from session (stable reference for dependency tracking)
  const userId = session?.user?.id

  // Track previous userId to detect user change (sign-up, sign-in, sign-out)
  const prevUserIdRef = useRef<string | null | undefined>(undefined)

  // Clear cached data when user changes to prevent stale workspace access errors
  // This handles the race condition during sign-up where old workspace data
  // may still be cached when the new user's session is established
  useEffect(() => {
    const prevUserId = prevUserIdRef.current

    // Skip on initial mount (prevUserId is undefined)
    if (prevUserId !== undefined && prevUserId !== userId) {
      // User has changed - clear all cached workspace data
      console.log("[useWorkspaceData] User changed, clearing cached data")
      
      // Reset auto-select state for the new user
      autoSelectState.selectedSlug = null
      autoSelectState.forUserId = null
      autoSelectState.timestamp = 0

      // Clear workspace slug from URL to prevent accessing old user's workspace
      if (workspaceSlug) {
        setWorkspaceSlug(null)
      }
    }

    prevUserIdRef.current = userId
  }, [userId, workspaceSlug, setWorkspaceSlug])

  // Reload workspaces from API when user changes or refetch is triggered
  useEffect(() => {
    const loadWorkspaces = async () => {
      if (!userId || !store?.workspaceCollection) {
        setIsLoadingWorkspaces(false)
        return
      }

      try {
        setIsLoadingWorkspaces(true)
        // Use the SDK collections (APIPersistence -> v2 API routes)
        // Load workspaces first (filtered by user), then members
        await store.workspaceCollection.loadAll({ userId })
        await store.memberCollection.loadAll({ userId })
      } catch (error) {
        console.error("[useWorkspaceData] Error loading workspaces:", error)
      } finally {
        setIsLoadingWorkspaces(false)
      }
    }

    loadWorkspaces()
  }, [userId, store, workspacesRefetchCounter])

  // Function to trigger a refetch of workspaces
  const refetchWorkspaces = useCallback(() => {
    setWorkspacesRefetchCounter((c) => c + 1)
  }, [])

  // Get workspaces for the current user from SDK
  // Uses memberCollection to find workspaces where user is a member
  // Include isLoadingWorkspaces in dependencies so it recomputes when loading completes
  const workspaces: any[] = useMemo(() => {
    if (!userId || !store?.workspaceCollection || !store?.memberCollection) {
      return []
    }
    try {
      // Get all members for this user
      const userMembers = store.memberCollection.all.filter(m => m.userId === userId)
      // Get workspace IDs from memberships
      const workspaceIds = new Set(userMembers.map(m => m.workspaceId))
      // Filter workspaces to those the user is a member of
      return store.workspaceCollection.all.filter(w => workspaceIds.has(w.id))
    } catch {
      return []
    }
  }, [userId, store, workspacesRefetchCounter, isLoadingWorkspaces])

  // Create a stable string representation of workspace IDs for dependency tracking
  // This ensures the effect runs when workspaces actually change (when IDs change)
  const workspaceIdsKey = useMemo(() => {
    return workspaces.map((ws: any) => ws.id).sort().join(",")
  }, [workspaces])

  // Get current workspace ID by slug - use ID to avoid holding stale MST node references
  const currentWorkspaceId = useMemo(() => {
    if (!workspaceSlug || workspaces.length === 0) return undefined
    const ws = workspaces.find((ws: any) => ws.slug === workspaceSlug)
    return ws?.id
  }, [workspaceSlug, workspaceIdsKey, workspaces.length])

  // Look up current workspace fresh from store (avoids detached node errors)
  const currentWorkspace = useMemo(() => {
    if (!currentWorkspaceId || !store?.workspaceCollection) return undefined
    try {
      return store.workspaceCollection.get(currentWorkspaceId)
    } catch {
      return undefined
    }
  }, [currentWorkspaceId, store, isLoadingWorkspaces])

  // Auto-select first workspace when user has workspaces but none is selected OR current selection is invalid
  // This ensures the user lands on a workspace after signup/login
  // Uses global autoSelectState to prevent multiple hook instances from all trying to auto-select
  useEffect(() => {
    // Skip if still loading
    if (isLoadingWorkspaces) {
      return
    }

    // Skip if no workspaces available
    if (workspaces.length === 0) {
      return
    }

    // Check if current workspace slug is valid
    const currentWorkspaceExists = workspaceSlug && workspaces.some((ws: any) => ws.slug === workspaceSlug)

    // Skip if we already have a valid workspace selected
    if (currentWorkspaceExists) {
      // Update global state to reflect the valid selection
      autoSelectState.selectedSlug = workspaceSlug
      autoSelectState.forUserId = userId || null
      return
    }

    // Check if another hook instance already performed auto-selection for this user
    // Allow re-selection if user changed or if selection was for a different user
    if (
      autoSelectState.selectedSlug &&
      autoSelectState.forUserId === userId &&
      Date.now() - autoSelectState.timestamp < 5000 // Within 5 seconds
    ) {
      // Another instance already selected, skip
      return
    }

    // Prefer a "personal" workspace if one exists, otherwise use first
    const personalWorkspace = workspaces.find((ws: any) =>
      ws.slug?.includes("personal") || ws.name?.toLowerCase().includes("personal")
    )
    const workspaceToSelect = personalWorkspace || workspaces[0]
    
    if (workspaceToSelect?.slug && workspaceToSelect.slug !== workspaceSlug) {
      // Mark globally that we're performing auto-selection
      autoSelectState.selectedSlug = workspaceToSelect.slug
      autoSelectState.forUserId = userId || null
      autoSelectState.timestamp = Date.now()
      
      console.log("[useWorkspaceData] Auto-selecting workspace:", workspaceToSelect.slug, "from", workspaces.length, "workspaces", workspaceSlug ? "(replacing invalid selection)" : "(no selection)")
      setWorkspaceSlug(workspaceToSelect.slug)
    }
  }, [isLoadingWorkspaces, workspaceIdsKey, workspaces.length, workspaceSlug, setWorkspaceSlug, userId])

  // Get current user's role in the current workspace from memberCollection
  let currentWorkspaceRole: "owner" | "admin" | "member" | "viewer" | undefined = undefined
  if (userId && currentWorkspaceId && store?.memberCollection) {
    try {
      const userMembers = store.memberCollection.all.filter(m => m.userId === userId)
      const wsMember = userMembers.find((m: any) => m.workspaceId === currentWorkspaceId)
      if (wsMember) {
        currentWorkspaceRole = wsMember.role as "owner" | "admin" | "member" | "viewer"
      }
    } catch {
      currentWorkspaceRole = undefined
    }
  }

  // Reload projects from API when workspace changes or refetch is triggered
  useEffect(() => {
    const loadProjects = async () => {
      if (!currentWorkspaceId || !store?.projectCollection) {
        setIsLoadingProjects(false)
        return
      }

      // Guard: Skip if workspace is not in current user's workspaces list
      // This prevents access denied errors during user transition
      if (workspaces.length > 0 && !workspaces.some((ws: any) => ws.id === currentWorkspaceId)) {
        console.log("[useWorkspaceData] Skipping project load - workspace not in user's list")
        setIsLoadingProjects(false)
        return
      }

      try {
        setIsLoadingProjects(true)
        // Use SDK collection (v2 API routes)
        await store.projectCollection.loadAll({ workspaceId: currentWorkspaceId })
      } catch (error) {
        console.error("[useWorkspaceData] Error loading projects:", error)
      } finally {
        setIsLoadingProjects(false)
      }
    }

    loadProjects()
  }, [currentWorkspaceId, store, projectsRefetchCounter, workspaces])

  // Function to trigger a refetch of projects
  const refetchProjects = useCallback(() => {
    setProjectsRefetchCounter((c) => c + 1)
  }, [])

  // Reload folders from API when workspace changes or refetch is triggered
  useEffect(() => {
    const loadFolders = async () => {
      if (!currentWorkspaceId || !store?.folderCollection) {
        setIsLoadingFolders(false)
        return
      }

      // Guard: Skip if workspace is not in current user's workspaces list
      // This prevents access denied errors during user transition
      if (workspaces.length > 0 && !workspaces.some((ws: any) => ws.id === currentWorkspaceId)) {
        console.log("[useWorkspaceData] Skipping folder load - workspace not in user's list")
        setIsLoadingFolders(false)
        return
      }

      try {
        setIsLoadingFolders(true)
        // Use SDK collection (v2 API routes)
        await store.folderCollection.loadAll({ workspaceId: currentWorkspaceId })
      } catch (error) {
        console.error("[useWorkspaceData] Error loading folders:", error)
      } finally {
        setIsLoadingFolders(false)
      }
    }

    loadFolders()
  }, [currentWorkspaceId, store, foldersRefetchCounter, workspaces])

  // Function to trigger a refetch of folders
  const refetchFolders = useCallback(() => {
    setFoldersRefetchCounter((c) => c + 1)
  }, [])

  // Reload starred projects from API when user changes or refetch is triggered
  useEffect(() => {
    const loadStarred = async () => {
      if (!userId || !store?.starredProjectCollection) {
        setIsLoadingStarred(false)
        return
      }

      try {
        setIsLoadingStarred(true)
        // Use SDK collection (v2 API routes)
        await store.starredProjectCollection.loadAll({ userId })
      } catch (error) {
        console.error("[useWorkspaceData] Error loading starred projects:", error)
      } finally {
        setIsLoadingStarred(false)
      }
    }

    loadStarred()
  }, [userId, store, starredRefetchCounter])

  // Function to trigger a refetch of starred projects
  const refetchStarredProjects = useCallback(() => {
    setStarredRefetchCounter((c) => c + 1)
  }, [])

  // Get folders for current workspace from SDK
  let folders: any[] = []
  if (currentWorkspaceId && store?.folderCollection) {
    try {
      folders = store.folderCollection.all.filter(f => f.workspaceId === currentWorkspaceId)
    } catch {
      folders = []
    }
  }

  // Find current folder by ID
  const currentFolder = folderId ? folders.find((f: any) => f.id === folderId) : undefined

  // Get breadcrumb path to current folder (ancestor chain)
  // Implements getAncestors by traversing parentId references
  let folderBreadcrumbs: any[] = []
  if (currentFolder && store?.folderCollection) {
    try {
      const ancestors: any[] = []
      let current = currentFolder
      while (current?.parentId) {
        const parent = store.folderCollection.get(current.parentId)
        if (parent) {
          ancestors.unshift(parent) // Add to beginning for root-first order
          current = parent
        } else {
          break
        }
      }
      folderBreadcrumbs = ancestors
    } catch {
      folderBreadcrumbs = []
    }
  }

  // Get projects for current workspace from SDK
  let projects: any[] = []
  if (currentWorkspaceId && store?.projectCollection) {
    try {
      projects = store.projectCollection.all.filter(p => p.workspaceId === currentWorkspaceId)
    } catch {
      projects = []
    }
  }

  // Find current project by ID
  const currentProject = projectId ? projects.find((p: any) => p.id === projectId) : undefined

  // Get starred project IDs for the current user
  let starredProjectIds = new Set<string>()
  let starredProjectEntries: any[] = []
  if (userId && store?.starredProjectCollection) {
    try {
      starredProjectEntries = store.starredProjectCollection.all.filter(s => s.userId === userId)
      starredProjectIds = new Set(starredProjectEntries.map((s: any) => s.projectId))
    } catch {
      starredProjectIds = new Set()
      starredProjectEntries = []
    }
  }

  // Get all projects across all workspaces to build starred projects list
  let allProjects: any[] = []
  if (store?.projectCollection) {
    try {
      allProjects = store.projectCollection.all
    } catch {
      allProjects = []
    }
  }

  // Build starred projects list with full project data
  const starredProjects = starredProjectEntries
    .map((entry: any) => {
      const project = allProjects.find((p: any) => p.id === entry.projectId)
      if (!project) return null
      // Include workspace info for context
      return {
        ...project,
        _starredAt: entry.createdAt,
        _workspaceId: entry.workspaceId,
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b._starredAt - a._starredAt) // Most recently starred first

  // Get shared workspaces (where user is member but NOT owner)
  let sharedWorkspaces: any[] = []
  if (userId && store?.memberCollection && workspaces.length > 0) {
    try {
      const userMembers = store.memberCollection.all.filter(m => m.userId === userId)
      sharedWorkspaces = workspaces.filter((ws: any) => {
        const membership = userMembers.find((m: any) => m.workspaceId === ws.id)
        return membership && membership.role !== "owner"
      })
    } catch {
      sharedWorkspaces = []
    }
  }

  // Get projects from shared workspaces
  const sharedWorkspaceIds = new Set(sharedWorkspaces.map((ws: any) => ws.id))
  const sharedProjects = allProjects.filter((p: any) =>
    sharedWorkspaceIds.has(p.workspace?.id)
  )

  // Helper function to check if a project is starred
  const isProjectStarred = useCallback((projectId: string): boolean => {
    return starredProjectIds.has(projectId)
  }, [starredProjectIds])

  // Helper function to toggle star status
  // Implements toggleStarProject using SDK collection create/delete
  const toggleStarProject = useCallback(async (projectId: string, workspaceId: string): Promise<boolean> => {
    if (!userId || !store?.starredProjectCollection) {
      return false
    }
    try {
      const isCurrentlyStarred = starredProjectIds.has(projectId)
      
      if (isCurrentlyStarred) {
        // Find and delete the starred project entry
        const entry = store.starredProjectCollection.all.find(
          s => s.userId === userId && s.projectId === projectId
        )
        if (entry) {
          await store.starredProjectCollection.delete(entry.id)
        }
      } else {
        // Create new starred project entry
        await store.starredProjectCollection.create({
          userId,
          projectId,
          workspaceId,
        })
      }
      
      // Trigger refetch to update the UI
      refetchStarredProjects()
      return !isCurrentlyStarred
    } catch (error) {
      console.error("[useWorkspaceData] Error toggling star:", error)
      return starredProjectIds.has(projectId)
    }
  }, [userId, store, starredProjectIds, refetchStarredProjects])

  // Get features for current project from SDK
  let features: any[] = []
  if (projectId && store?.featureSessionCollection) {
    try {
      features = store.featureSessionCollection.all.filter(f => f.projectId === projectId)
    } catch {
      features = []
    }
  }

  // Find current feature by ID
  const currentFeature = featureId ? features.find((f: any) => f.id === featureId) : undefined

  // Group features by their actual status (matches PHASES)
  const featuresByPhase: Record<string, any[]> = {
    discovery: [],
    analysis: [],
    classification: [],
    design: [],
    spec: [],
    testing: [],
    implementation: [],
    complete: [],
  }

  for (const feature of features) {
    const status = feature.status || "discovery"
    if (featuresByPhase[status]) {
      featuresByPhase[status].push(feature)
    } else {
      // For unknown statuses, add to discovery
      featuresByPhase.discovery.push(feature)
    }
  }

  // Determine loading state - combines session loading, workspace loading, project loading, folder loading, and starred loading
  const isLoading = isSessionLoading || isLoadingWorkspaces || isLoadingProjects || isLoadingFolders || isLoadingStarred

  return {
    workspaces,
    currentWorkspace,
    currentWorkspaceRole,
    projects,
    currentProject,
    folders,
    currentFolder,
    folderBreadcrumbs,
    features,
    currentFeature,
    featuresByPhase,
    starredProjectIds,
    starredProjects,
    sharedWorkspaces,
    sharedProjects,
    isLoading,
    refetchWorkspaces,
    refetchProjects,
    refetchFolders,
    refetchStarredProjects,
    toggleStarProject,
    isProjectStarred,
  }
}
