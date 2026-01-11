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
  /** Organizations the current user has access to */
  orgs: any[]
  /** Currently selected organization (by slug) */
  currentOrg: any | undefined
  /** Current user's role in the current organization */
  currentOrgRole: "owner" | "admin" | "member" | "viewer" | undefined
  /** Projects for the current organization */
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
  /** Function to refetch organizations (call after creating org or signup) */
  refetchOrgs: () => void
  /** Function to refetch projects (call after creating project) */
  refetchProjects: () => void
}

/**
 * Hook for accessing workspace data derived from URL state and API/domain queries.
 *
 * Combines:
 * - useWorkspaceNavigation() for URL state (org slug, project ID, feature ID)
 * - useSession() for auth state
 * - API calls for organizations (/api/me/orgs)
 * - useDomains() for projects and features (studioCore, platformFeatures)
 *
 * @example
 * ```tsx
 * const {
 *   orgs,
 *   currentOrg,
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
  // Get URL state
  const { org: orgSlug, projectId, featureId } = useWorkspaceNavigation()

  // Get auth session from Better Auth
  const { data: session, isPending: isSessionLoading } = useSession()

  // Get domains for orgs, projects, and features
  const { studioCore, platformFeatures } = useDomains()

  // State for tracking loading and refetch
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(true)
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)
  const [orgsRefetchCounter, setOrgsRefetchCounter] = useState(0)
  const [projectsRefetchCounter, setProjectsRefetchCounter] = useState(0)

  // User ID from session (stable reference for dependency tracking)
  const userId = session?.user?.id

  // Reload organizations from MCP when user changes or refetch is triggered
  useEffect(() => {
    const loadOrgs = async () => {
      if (!userId || !studioCore?.organizationCollection) {
        setIsLoadingOrgs(false)
        return
      }

      try {
        setIsLoadingOrgs(true)
        // Reload orgs and members from backend
        await studioCore.organizationCollection.query().toArray()
        await studioCore.memberCollection.query().toArray()
      } catch (error) {
        console.error("[useWorkspaceData] Error loading orgs:", error)
      } finally {
        setIsLoadingOrgs(false)
      }
    }

    loadOrgs()
  }, [userId, studioCore, orgsRefetchCounter])

  // Function to trigger a refetch of organizations
  const refetchOrgs = useCallback(() => {
    setOrgsRefetchCounter((c) => c + 1)
  }, [])

  // Get orgs for the current user from MCP
  let orgs: any[] = []
  if (userId && studioCore?.organizationCollection) {
    try {
      orgs = studioCore.organizationCollection.findByMembership(userId)
    } catch {
      orgs = []
    }
  }

  // Find current organization by slug
  const currentOrg = orgSlug ? orgs.find((org: any) => org.slug === orgSlug) : undefined

  // Get current user's role in the current org from memberCollection
  let currentOrgRole: "owner" | "admin" | "member" | "viewer" | undefined = undefined
  if (userId && currentOrg?.id && studioCore?.memberCollection) {
    try {
      const userMembers = studioCore.memberCollection.findByUserId(userId)
      const orgMember = userMembers.find((m: any) => m.organization?.id === currentOrg.id)
      if (orgMember) {
        currentOrgRole = orgMember.role as "owner" | "admin" | "member" | "viewer"
      }
    } catch {
      currentOrgRole = undefined
    }
  }

  // Reload projects from MCP when org changes or refetch is triggered
  useEffect(() => {
    const loadProjects = async () => {
      if (!currentOrg?.id || !studioCore?.projectCollection) {
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
  }, [currentOrg?.id, studioCore, projectsRefetchCounter])

  // Function to trigger a refetch of projects
  const refetchProjects = useCallback(() => {
    setProjectsRefetchCounter((c) => c + 1)
  }, [])

  // Get projects for current organization from MCP
  let projects: any[] = []
  if (currentOrg?.id && studioCore?.projectCollection) {
    try {
      projects = studioCore.projectCollection.findByOrganization(currentOrg.id)
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

  // Determine loading state - combines session loading, org loading, and project loading
  const isLoading = isSessionLoading || isLoadingOrgs || isLoadingProjects

  return {
    orgs,
    currentOrg,
    currentOrgRole,
    projects,
    currentProject,
    features,
    currentFeature,
    featuresByPhase,
    isLoading,
    refetchOrgs,
    refetchProjects,
  }
}
