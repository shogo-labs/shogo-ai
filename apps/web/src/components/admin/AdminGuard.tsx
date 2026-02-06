/**
 * AdminGuard - Protects admin routes by checking super_admin role.
 *
 * Redirects non-admin users back to the home page.
 */

import { Navigate } from 'react-router-dom'
import { useSessionContext } from '@/contexts/SessionProvider'
import { Loader2 } from 'lucide-react'

interface AdminGuardProps {
  children: React.ReactNode
}

export function AdminGuard({ children }: AdminGuardProps) {
  const { isSuperAdmin, isPending, isAuthenticated, userRole } = useSessionContext()

  // Still loading session/role
  if (isPending || (isAuthenticated && userRole === null)) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Not authenticated or not a super admin
  if (!isAuthenticated || !isSuperAdmin) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
