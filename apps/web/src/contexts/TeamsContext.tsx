/**
 * TeamsContext - React context for teams domain store
 *
 * Provides a teams store for managing organizations, teams, memberships,
 * apps, and invitations. The store is initialized on mount and provides
 * reactive views and actions for team management.
 *
 * Usage:
 * ```tsx
 * <TeamsProvider>
 *   <MyApp />
 * </TeamsProvider>
 *
 * function MyApp() {
 *   const teams = useTeams()
 *
 *   // Create an organization
 *   teams.organizationCollection.add({
 *     id: crypto.randomUUID(),
 *     name: 'My Org',
 *     slug: 'my-org',
 *     createdAt: Date.now()
 *   })
 *
 *   // Check permissions
 *   const role = teams.resolvePermissions(userId, 'team', teamId)
 * }
 * ```
 */

import { createContext, useContext, useRef, useEffect, type ReactNode } from "react"
import { createTeamsStore, NullPersistence } from "@shogo/state-api"

interface TeamsContextValue {
  store: any
}

const TeamsContext = createContext<TeamsContextValue | null>(null)

export interface TeamsProviderProps {
  children: ReactNode
}

/**
 * Provider that creates a teams domain store.
 *
 * Features:
 * - Creates stable store instance (useRef)
 * - Initializes collections on mount
 * - Cleans up on unmount
 */
export function TeamsProvider({ children }: TeamsProviderProps) {
  const contextRef = useRef<TeamsContextValue | null>(null)

  // Initialize store once
  if (!contextRef.current) {
    const env = {
      services: {
        persistence: new NullPersistence(),
      },
      context: {
        schemaName: "teams",
      },
    }

    const result = createTeamsStore()
    const store = result.createStore(env)

    contextRef.current = { store }
  }

  // Initialize store on mount
  useEffect(() => {
    // Store is ready to use - no async initialization needed for domain stores
    // This effect is here for cleanup purposes

    return () => {
      // Cleanup on unmount
      // Domain stores don't have external subscriptions to clean up
    }
  }, [])

  return (
    <TeamsContext.Provider value={contextRef.current}>
      {children}
    </TeamsContext.Provider>
  )
}

/**
 * Hook to access the teams store.
 *
 * The teams store provides:
 * - Collections: organizationCollection, teamCollection, membershipCollection, appCollection, invitationCollection
 * - Views: resolvePermissions(userId, resourceType, resourceId)
 * - Collection queries: membershipCollection.findByUserId(userId), findForResource(type, id)
 *
 * Use with observer() from mobx-react-lite for reactive updates:
 * ```tsx
 * import { observer } from 'mobx-react-lite'
 *
 * const MyComponent = observer(() => {
 *   const teams = useTeams()
 *   const orgs = teams.organizationCollection.all()
 *   return <div>{orgs.length} organizations</div>
 * })
 * ```
 *
 * @returns The teams store instance
 * @throws Error if used outside TeamsProvider
 */
export function useTeams() {
  const context = useContext(TeamsContext)
  if (!context) {
    throw new Error("useTeams must be used within TeamsProvider")
  }
  return context.store
}
