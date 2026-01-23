/**
 * useWorkspaceData Hook
 * Task: task-2-2-002
 *
 * Combines URL state with MCP domain queries to provide workspace data.
 * Uses useWorkspaceNavigation() + domain queries to derive the complete workspace context.
 *
 * Per design decision design-2-2-data-flow:
 * - Components receive derived data, don't call domains directly
 * - workspaces fetched from MCP (studioCore.workspaceCollection)
 * - projects fetched from MCP (studioCore.projectCollection)
 * - features from MCP (platformFeatures.featureSessionCollection)
 * - features grouped by StatusToPhase map into featuresByPhase
 *
 * Note: This hook triggers MCP reload when userId/workspaceId changes.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useDomains } from "@shogo/app-core"
import { useWorkspaceNavigation } from "./useWorkspaceNavigation"
import { useSession } from "../../../../auth/client"

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
 * - API calls for workspaces (/api/me/workspaces)
 * - useDomains() for projects and features (studioCore, platformFeatures)
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

  // Get domains for workspaces, projects, and features
  // Note: platformFeatures is optional - not loaded in consumer app
  const { studioCore, platformFeatures } = useDomains<{
    studioCore: any
    platformFeatures?: any
  }>()

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

  // Reload workspaces from MCP when user changes or refetch is triggered
  useEffect(() => {
    const loadWorkspaces = async () => {
      if (!userId || !studioCore?.workspaceCollection) {
        setIsLoadingWorkspaces(false)
        return
      }

      try {
        setIsLoadingWorkspaces(true)
        // Reload workspaces and members from backend
        await studioCore.workspaceCollection.query().toArray()
        await studioCore.memberCollection.query().toArray()
      } catch (error) {
        console.error("[useWorkspaceData] Error loading workspaces:", error)
      } finally {
        setIsLoadingWorkspaces(false)
      }
    }

    loadWorkspaces()
  }, [userId, studioCore, workspacesRefetchCounter])

  // Function to trigger a refetch of workspaces
  const refetchWorkspaces = useCallback(() => {
    setWorkspacesRefetchCounter((c) => c + 1)
  }, [])

  // Get workspaces for the current user from MCP
  // Include isLoadingWorkspaces in dependencies so it recomputes when loading completes
  const workspaces: any[] = useMemo(() => {
    if (!userId || !studioCore?.workspaceCollection) {
      return []
    }
    try {
      return studioCore.workspaceCollection.findByMembership(userId)
    } catch {
      return []
    }
  }, [userId, studioCore, workspacesRefetchCounter, isLoadingWorkspaces])

  // Create a stable string representation of workspace IDs for dependency tracking
  // This ensures the effect runs when workspaces actually change (when IDs change)
  const workspaceIdsKey = useMemo(() => {
    return workspaces.map((ws: any) => ws.id).sort().join(",")
  }, [workspaces])

  // Find current workspace by slug
  const currentWorkspace = workspaceSlug ? workspaces.find((ws: any) => ws.slug === workspaceSlug) : undefined

  // Auto-select first workspace when user has workspaces but none is selected OR current selection is invalid
  // This ensures the user lands on a workspace after signup/login
  useEffect(() => {
    // Only auto-select when:
    // 1. Data has finished loading
    // 2. User has at least one workspace
    // 3. No workspace is currently selected OR the selected workspace doesn't exist in the user's workspaces
    const needsAutoSelect = !isLoadingWorkspaces && workspaces.length > 0 && (!workspaceSlug || !currentWorkspace)
    
    if (needsAutoSelect) {
      // Prefer a "personal" workspace if one exists, otherwise use first
      const personalWorkspace = workspaces.find((ws: any) =>
        ws.slug?.includes("personal") || ws.name?.toLowerCase().includes("personal")
      )
      const workspaceToSelect = personalWorkspace || workspaces[0]
      if (workspaceToSelect?.slug) {
        console.log("[useWorkspaceData] Auto-selecting workspace:", workspaceToSelect.slug, "from", workspaces.length, "workspaces", workspaceSlug ? "(replacing invalid selection)" : "(no selection)")
        setWorkspaceSlug(workspaceToSelect.slug)
      }
    }
  }, [isLoadingWorkspaces, workspaceIdsKey, workspaces.length, workspaceSlug, currentWorkspace, setWorkspaceSlug, workspaces])

  // Get current user's role in the current workspace from memberCollection
  let currentWorkspaceRole: "owner" | "admin" | "member" | "viewer" | undefined = undefined
  if (userId && currentWorkspace?.id && studioCore?.memberCollection) {
    try {
      const userMembers = studioCore.memberCollection.findByUserId(userId)
      const wsMember = userMembers.find((m: any) => m.workspace?.id === currentWorkspace.id)
      if (wsMember) {
        currentWorkspaceRole = wsMember.role as "owner" | "admin" | "member" | "viewer"
      }
    } catch {
      currentWorkspaceRole = undefined
    }
  }

  // Reload projects from MCP when workspace changes or refetch is triggered
  useEffect(() => {
    const loadProjects = async () => {
      if (!currentWorkspace?.id || !studioCore?.projectCollection) {
        setIsLoadingProjects(false)
        return
      }

      try {
        setIsLoadingProjects(true)
        // Reload projects from backend
        await studioCore.projectCollection.query().toArray()
      } catch (error) {
        console.error("[useWorkspaceData] Error loading projects:", error)
      } finally {
        setIsLoadingProjects(false)
      }
    }

    loadProjects()
  }, [currentWorkspace?.id, studioCore, projectsRefetchCounter])

  // Function to trigger a refetch of projects
  const refetchProjects = useCallback(() => {
    setProjectsRefetchCounter((c) => c + 1)
  }, [])

  // Reload folders from MCP when workspace changes or refetch is triggered
  useEffect(() => {
    const loadFolders = async () => {
      if (!currentWorkspace?.id || !studioCore?.folderCollection) {
        setIsLoadingFolders(false)
        return
      }

      try {
        setIsLoadingFolders(true)
        // Reload folders from backend
        await studioCore.folderCollection.query().toArray()
      } catch (error) {
        console.error("[useWorkspaceData] Error loading folders:", error)
      } finally {
        setIsLoadingFolders(false)
      }
    }

    loadFolders()
  }, [currentWorkspace?.id, studioCore, foldersRefetchCounter])

  // Function to trigger a refetch of folders
  const refetchFolders = useCallback(() => {
    setFoldersRefetchCounter((c) => c + 1)
  }, [])

  // Reload starred projects from MCP when user changes or refetch is triggered
  useEffect(() => {
    const loadStarred = async () => {
      if (!userId || !studioCore?.starredProjectCollection) {
        setIsLoadingStarred(false)
        return
      }

      try {
        setIsLoadingStarred(true)
        // Reload starred projects from backend
        await studioCore.starredProjectCollection.query().toArray()
      } catch (error) {
        console.error("[useWorkspaceData] Error loading starred projects:", error)
      } finally {
        setIsLoadingStarred(false)
      }
    }

    loadStarred()
  }, [userId, studioCore, starredRefetchCounter])

  // Function to trigger a refetch of starred projects
  const refetchStarredProjects = useCallback(() => {
    setStarredRefetchCounter((c) => c + 1)
  }, [])

  // Get folders for current workspace from MCP
  let folders: any[] = []
  if (currentWorkspace?.id && studioCore?.folderCollection) {
    try {
      folders = studioCore.folderCollection.findByWorkspace(currentWorkspace.id)
    } catch {
      folders = []
    }
  }

  // Find current folder by ID
  const currentFolder = folderId ? folders.find((f: any) => f.id === folderId) : undefined

  // Get breadcrumb path to current folder (ancestor chain)
  let folderBreadcrumbs: any[] = []
  if (currentFolder && studioCore?.folderCollection) {
    try {
      folderBreadcrumbs = studioCore.folderCollection.getAncestors(currentFolder.id)
    } catch {
      folderBreadcrumbs = []
    }
  }

  // Get projects for current workspace from MCP
  let projects: any[] = []
  if (currentWorkspace?.id && studioCore?.projectCollection) {
    try {
      projects = studioCore.projectCollection.findByWorkspace(currentWorkspace.id)
    } catch {
      projects = []
    }
  }

  // Find current project by ID
  const currentProject = projectId ? projects.find((p: any) => p.id === projectId) : undefined

  // Get starred project IDs for the current user
  let starredProjectIds = new Set<string>()
  let starredProjectEntries: any[] = []
  if (userId && studioCore?.starredProjectCollection) {
    try {
      starredProjectEntries = studioCore.starredProjectCollection.findByUser(userId)
      starredProjectIds = new Set(starredProjectEntries.map((s: any) => s.projectId))
    } catch {
      starredProjectIds = new Set()
      starredProjectEntries = []
    }
  }

  // Get all projects across all workspaces to build starred projects list
  let allProjects: any[] = []
  if (studioCore?.projectCollection) {
    try {
      allProjects = studioCore.projectCollection.all()
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
  if (userId && studioCore?.memberCollection && workspaces.length > 0) {
    try {
      const userMembers = studioCore.memberCollection.findByUserId(userId)
      sharedWorkspaces = workspaces.filter((ws: any) => {
        const membership = userMembers.find((m: any) => m.workspace?.id === ws.id)
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
  const toggleStarProject = useCallback(async (projectId: string, workspaceId: string): Promise<boolean> => {
    if (!userId || !studioCore) {
      return false
    }
    try {
      const result = await studioCore.toggleStarProject(userId, projectId, workspaceId)
      // Trigger refetch to update the UI
      refetchStarredProjects()
      return result
    } catch (error) {
      console.error("[useWorkspaceData] Error toggling star:", error)
      return starredProjectIds.has(projectId)
    }
  }, [userId, studioCore, starredProjectIds, refetchStarredProjects])

  // Get features for current project
  // Per finding-2-2-005: featureSessionCollection.findByProject(projectId)
  let features: any[] = []
  if (projectId && platformFeatures?.featureSessionCollection) {
    try {
      features = platformFeatures.featureSessionCollection.findByProject(projectId)
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
