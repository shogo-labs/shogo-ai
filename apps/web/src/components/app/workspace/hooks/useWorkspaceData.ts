/**
 * useWorkspaceData Hook
 * Task: task-2-2-002
 *
 * Combines URL state with domain queries to provide workspace data.
 * Uses useWorkspaceNavigation() + useDomains() + useAuth() to derive
 * the complete workspace context.
 *
 * Per design decision design-2-2-data-flow:
 * - Components receive derived data, don't call domains directly
 * - orgs derived from memberCollection.findByUserId()
 * - features grouped by StatusToPhase map into featuresByPhase
 */

import { useMemo } from "react"
import { useDomains } from "../../../../contexts/DomainProvider"
import { useAuth } from "../../../../contexts/AuthContext"
import { useWorkspaceNavigation } from "./useWorkspaceNavigation"
import { StatusToPhase } from "@shogo/state-api"

/**
 * Phase type for feature grouping
 */
export type Phase = "discovery" | "design" | "build" | "deploy"

/**
 * All phases in the platform features workflow
 */
export const PHASES: Phase[] = ["discovery", "design", "build", "deploy"]

/**
 * Return type for useWorkspaceData hook
 */
export interface WorkspaceDataState {
  /** Organizations the current user has access to */
  orgs: any[]
  /** Currently selected organization (by slug) */
  currentOrg: any | undefined
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
}

/**
 * Hook for accessing workspace data derived from URL state and domain queries.
 *
 * Combines:
 * - useWorkspaceNavigation() for URL state (org slug, project ID, feature ID)
 * - useDomains() for studioCore and platformFeatures domains
 * - useAuth() for current user ID
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

  // Get domains
  const { studioCore, platformFeatures } = useDomains<{
    studioCore: any
    platformFeatures: any
  }>()

  // Get current user
  const auth = useAuth()
  const userId = auth?.currentUser?.id

  // Derive organizations from member collection
  // Per finding-2-2-004: memberCollection.findByUserId(userId) -> derive orgs from member.organization refs
  const orgs = useMemo(() => {
    if (!userId || !studioCore?.memberCollection) {
      return []
    }

    try {
      const members = studioCore.memberCollection.findByUserId(userId)
      // Get unique organizations from members that have organization refs
      const orgMap = new Map<string, any>()
      for (const member of members) {
        if (member.organization) {
          orgMap.set(member.organization.id, member.organization)
        }
      }
      return Array.from(orgMap.values())
    } catch {
      return []
    }
  }, [userId, studioCore?.memberCollection])

  // Find current organization by slug
  const currentOrg = useMemo(() => {
    if (!orgSlug) return undefined
    return orgs.find((org: any) => org.slug === orgSlug)
  }, [orgSlug, orgs])

  // Get projects for current organization
  const projects = useMemo(() => {
    if (!currentOrg?.id || !studioCore?.projectCollection) {
      return []
    }

    try {
      return studioCore.projectCollection.findByOrganization(currentOrg.id)
    } catch {
      return []
    }
  }, [currentOrg?.id, studioCore?.projectCollection])

  // Find current project by ID
  const currentProject = useMemo(() => {
    if (!projectId) return undefined
    return projects.find((p: any) => p.id === projectId)
  }, [projectId, projects])

  // Get features for current project
  // Per finding-2-2-005: featureSessionCollection.findByProject(projectId)
  const features = useMemo(() => {
    if (!projectId || !platformFeatures?.featureSessionCollection) {
      return []
    }

    try {
      return platformFeatures.featureSessionCollection.findByProject(projectId)
    } catch {
      return []
    }
  }, [projectId, platformFeatures?.featureSessionCollection])

  // Find current feature by ID
  const currentFeature = useMemo(() => {
    if (!featureId) return undefined
    return features.find((f: any) => f.id === featureId)
  }, [featureId, features])

  // Group features by phase using StatusToPhase map
  const featuresByPhase = useMemo(() => {
    const grouped: Record<string, any[]> = {
      discovery: [],
      design: [],
      build: [],
      deploy: [],
    }

    for (const feature of features) {
      const phase = StatusToPhase[feature.status] || "discovery"
      if (grouped[phase]) {
        grouped[phase].push(feature)
      } else {
        // For phases not in our standard list, add to discovery
        grouped.discovery.push(feature)
      }
    }

    return grouped
  }, [features])

  // Determine loading state
  // For now, we're not doing async loading, so isLoading is always false
  // In the future, this could track async queries
  const isLoading = false

  return {
    orgs,
    currentOrg,
    projects,
    currentProject,
    features,
    currentFeature,
    featuresByPhase,
    isLoading,
  }
}
