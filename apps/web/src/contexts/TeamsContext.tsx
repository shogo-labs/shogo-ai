/**
 * TeamsContext - Backward-compatible wrapper for ApplicationDomains
 *
 * @deprecated Use `useDomain(teamsDomain)` from ApplicationDomains instead.
 *
 * This file is kept for backward compatibility with existing code.
 * New code should use the ApplicationDomains pattern:
 *
 * ```tsx
 * import { useDomain } from './contexts/ApplicationDomains'
 * import { teamsDomain } from '@shogo/state-api'
 *
 * function MyComponent() {
 *   const teams = useDomain(teamsDomain)
 *   // ...
 * }
 * ```
 */

import { type ReactNode } from "react"
import { teamsDomain } from "@shogo/state-api"
import { ApplicationDomains, useDomain } from "./ApplicationDomains"
import { MCPPersistence } from "../persistence/MCPPersistence"
import { mcpService } from "../services/mcpService"

// Shared persistence instance for backward-compat TeamsProvider
const teamsLegacyPersistence = new MCPPersistence(mcpService)

export interface TeamsProviderProps {
  children: ReactNode
}

/**
 * @deprecated Use ApplicationDomains with domains={[teamsDomain]} instead
 *
 * This wrapper maintains backward compatibility with existing code.
 */
export function TeamsProvider({ children }: TeamsProviderProps) {
  return (
    <ApplicationDomains
      domains={[teamsDomain]}
      persistence={teamsLegacyPersistence}
      autoRegister={false} // Don't auto-register since this is legacy pattern
    >
      {children}
    </ApplicationDomains>
  )
}

/**
 * @deprecated Use `useDomain(teamsDomain)` instead
 */
export function useTeams() {
  return useDomain(teamsDomain)
}
