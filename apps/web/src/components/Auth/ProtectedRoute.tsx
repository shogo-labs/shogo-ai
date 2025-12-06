/**
 * ProtectedRoute component
 * Task: task-auth-012
 * Requirement: req-auth-004
 *
 * Route wrapper that:
 * - Shows loading spinner during auth initialization
 * - Redirects to login if not authenticated
 * - Renders children if authenticated
 * - Preserves intended destination for post-login redirect
 */

import { type ReactNode } from "react"
import { observer } from "mobx-react-lite"
import { Navigate, useLocation } from "react-router-dom"
import { useAuth } from "../../hooks/useAuth"

export interface ProtectedRouteProps {
  children: ReactNode
  /** Custom redirect path, defaults to /login */
  redirectTo?: string
}

/**
 * Protects routes that require authentication
 *
 * Usage:
 * ```tsx
 * <Route path="/dashboard" element={
 *   <ProtectedRoute>
 *     <Dashboard />
 *   </ProtectedRoute>
 * } />
 * ```
 */
export const ProtectedRoute = observer(function ProtectedRoute({
  children,
  redirectTo = "/login",
}: ProtectedRouteProps) {
  const location = useLocation()
  const { isAuthenticated, loading } = useAuth()

  // Show loading state while checking auth
  // This prevents flash of login page for authenticated users
  if (loading) {
    return (
      <div className="auth-loading" aria-busy="true" aria-live="polite">
        <div className="auth-loading-spinner" />
        <span className="sr-only">Checking authentication...</span>
      </div>
    )
  }

  // Not authenticated - redirect to login
  // Preserve the intended destination for redirect after login
  if (!isAuthenticated) {
    return (
      <Navigate
        to={redirectTo}
        state={{ from: location.pathname }}
        replace
      />
    )
  }

  // Authenticated - render protected content
  return <>{children}</>
})
