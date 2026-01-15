/**
 * useWorkspaceData Hook
 * Task: task-2-2-002
 *
 * Combines URL state with MCP domain queries to provide workspace data.
 * Uses useWorkspaceNavigation() + domain queries to derive the complete workspace context.
 *
 * Per design decision design-2-2-data-flow:
 * - Components receive derived data, don't call domains directly
 * - orgs fetched from MCP (studioCore.organizationCollection)
 * - projects fetched from MCP (studioCore.projectCollection)
 * - features from MCP (platformFeatures.featureSessionCollection)
 * - features grouped by StatusToPhase map into featuresByPhase
 *
 * Note: This hook triggers MCP reload when userId/orgId changes.
 */

import { useState, useEffect, useCallback } from "react"
import { useDomains } from "../../../../contexts/DomainProvider"
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
  /** Features for the current project */
  features: any[]
  /** Currently selected feature (by ID) */
  currentFeature: any | undefined
  /** Features grouped by phase */
  featuresByPhase: Record<string, any[]>
  /** Loading state */
  isLoading: boolean
  /** Function to refetch workspaces (call after creating workspace or signup) */
  refetchWorkspaces: () => void
  /** Function to refetch projects (call after creating project) */
  refetchProjects: () => void
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
  // Get URL state (org is now workspace slug) and setters
  const { org: workspaceSlug, projectId, featureId, setOrg } = useWorkspaceNavigation()

  // Get auth session from Better Auth
  const { data: session, isPending: isSessionLoading } = useSession()

  // Get domains for workspaces, projects, and features
  const { studioCore, platformFeatures } = useDomains()

  // State for tracking loading and refetch
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true)
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)
  const [workspacesRefetchCounter, setWorkspacesRefetchCounter] = useState(0)
  const [projectsRefetchCounter, setProjectsRefetchCounter] = useState(0)

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
  let workspaces: any[] = []
  if (userId && studioCore?.workspaceCollection) {
    try {
      workspaces = studioCore.workspaceCollection.findByMembership(userId)
    } catch {
      workspaces = []
    }
  }

  // Find current workspace by slug
  const currentWorkspace = workspaceSlug ? workspaces.find((ws: any) => ws.slug === workspaceSlug) : undefined

  // Auto-select first workspace when user has workspaces but none is selected
  // This ensures the user lands on a workspace after signup/login
  useEffect(() => {
    // Only auto-select when:
    // 1. Data has finished loading
    // 2. User has at least one workspace
    // 3. No workspace is currently selected in URL
    if (!isLoadingWorkspaces && workspaces.length > 0 && !workspaceSlug) {
      // Prefer a "personal" workspace if one exists, otherwise use first
      const personalWorkspace = workspaces.find((ws: any) =>
        ws.slug?.includes("personal") || ws.name?.toLowerCase().includes("personal")
      )
      const workspaceToSelect = personalWorkspace || workspaces[0]
      setOrg(workspaceToSelect.slug)
    }
  }, [isLoadingWorkspaces, workspaces.length, workspaceSlug, setOrg])

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

  // Determine loading state - combines session loading, workspace loading, and project loading
  const isLoading = isSessionLoading || isLoadingWorkspaces || isLoadingProjects

  return {
    workspaces,
    currentWorkspace,
    currentWorkspaceRole,
    projects,
    currentProject,
    features,
    currentFeature,
    featuresByPhase,
    isLoading,
    refetchWorkspaces,
    refetchProjects,
  }
}
