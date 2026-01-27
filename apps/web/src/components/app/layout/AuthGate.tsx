/**
 * AuthGate Component
 *
 * Protects /app routes by checking authentication state.
 * Task: task-2-1-012
 * Integration Point: ip-2-1-auth-gate
 *
 * Features:
 * - Checks auth.isAuthenticated from useDomains().auth
 * - Shows SplashScreen during auth.authStatus === 'loading' (with no currentUser)
 * - Renders LoginPage for unauthenticated users
 * - Renders children (AppShell) for authenticated users
 * - Calls auth.initialize() on mount via useEffect
 * - MobX observer for reactive auth state updates
 * - Checks for pending invitations on login (task-wsmm-011)
 *
 * Design Decision: dd-2-1-route-structure
 * AuthGate wraps /app/* and renders LoginPage for unauthenticated users inline -
 * there is NO /app/login route. The LoginPage is rendered in-place.
 */

import { useEffect, useRef } from "react"
import { observer } from "mobx-react-lite"
import { useDomains, useSDKDomain } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { SplashScreen } from "../shared/SplashScreen"
import { LoginPage } from "../auth/LoginPage"

interface AuthGateProps {
  children: React.ReactNode
}

/**
 * AuthGate - Protects /app routes based on authentication state
 *
 * State machine:
 * 1. Loading (auth.authStatus === 'loading' && !auth.currentUser) -> SplashScreen
 * 2. Unauthenticated (!auth.isAuthenticated) -> LoginPage
 * 3. Authenticated (auth.isAuthenticated) -> children (AppShell)
 *
 * The component is wrapped with MobX observer to reactively respond to
 * auth state changes from the betterAuthDomain store.
 */
export const AuthGate = observer(function AuthGate({ children }: AuthGateProps) {
  const { auth } = useDomains()
  const store = useSDKDomain() as IDomainStore
  const hasCheckedInvitations = useRef(false)

  // Initialize auth on mount - checks for existing session
  useEffect(() => {
    auth.initialize()
  }, [auth])

  // Check for pending invitations after user authenticates
  // This runs once per session to load invitations for the user
  useEffect(() => {
    if (auth.isAuthenticated && auth.currentUser && !hasCheckedInvitations.current) {
      hasCheckedInvitations.current = true

      // Load pending invitations for this user's email
      // This is fire-and-forget - errors are logged but don't block auth
      if (store?.invitationCollection) {
        store.invitationCollection.loadAll({ email: auth.currentUser.email })
          .catch((error: any) => {
            console.error("[AuthGate] Failed to load pending invitations:", error)
          })
      }
    }
  }, [auth.isAuthenticated, auth.currentUser, store])

  // Show splash screen during initial auth check
  // This only shows when loading AND there's no current user
  if (auth.authStatus === "loading" && !auth.currentUser) {
    return <SplashScreen />
  }

  // Show login page if not authenticated
  if (!auth.isAuthenticated) {
    return <LoginPage />
  }

  // Render protected content
  return <>{children}</>
})

export default AuthGate
