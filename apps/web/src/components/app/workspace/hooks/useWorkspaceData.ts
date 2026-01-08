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
 *
 * Note: This hook relies on MobX observer reactivity. Components using this
 * hook should be wrapped with observer() to automatically re-render when
 * accessed MST observables change. useMemo is intentionally NOT used as it
 * would break MobX's automatic dependency tracking.
 */

import { useDomains } from "../../../../contexts/DomainProvider"
import { useWorkspaceNavigation } from "./useWorkspaceNavigation"

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

  // Get domains (including auth for currentUser)
  const { studioCore, platformFeatures, auth } = useDomains()

  // Get current user from betterAuthDomain (synced with session)
  const userId = auth?.currentUser?.id

  // Derive organizations from member collection
  // Per finding-2-2-004: memberCollection.findByUserId(userId) -> derive orgs from member.organization refs
  // Note: No useMemo - MobX observer tracks MST observable access automatically
  let orgs: any[] = []
  if (userId && studioCore?.memberCollection) {
    try {
      const members = studioCore.memberCollection.findByUserId(userId)
      // Get unique organizations from members that have organization refs
      const orgMap = new Map<string, any>()
      for (const member of members) {
        if (member.organization) {
          orgMap.set(member.organization.id, member.organization)
        }
      }
      orgs = Array.from(orgMap.values())
    } catch {
      orgs = []
    }
  }

  // Find current organization by slug
  const currentOrg = orgSlug ? orgs.find((org: any) => org.slug === orgSlug) : undefined

  // Get projects for current organization
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
