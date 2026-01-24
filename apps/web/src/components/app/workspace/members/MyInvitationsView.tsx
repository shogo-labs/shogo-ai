/**
 * MyInvitationsView Component
 * Task: task-my-invitations-ui
 * Feature: member-management-invitation
 *
 * Displays pending invitations for the current user.
 * Allows accepting or declining invitations.
 *
 * Uses MCP domain (studioCore) for all data operations.
 */

import { useState, useEffect, useCallback } from "react"
import { Loader2, Check, X, Building2, Clock, AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/contexts/SessionProvider"

/**
 * Invitation data from MCP domain
 */
interface MyInvitation {
  id: string
  email: string
  role: "owner" | "admin" | "member" | "viewer"
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled"
  expiresAt: number
  createdAt: number
  isExpired: boolean
  workspace?: { id: string; name: string }
  project?: { id: string; name: string }
}

/**
 * Props for MyInvitationsView component
 */
export interface MyInvitationsViewProps {
  /** Callback after accepting/declining an invitation */
  onInvitationResponse?: () => void
}

/**
 * Role badge variant mapping
 */
const roleBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  owner: "default",
  admin: "secondary",
  member: "outline",
  viewer: "outline",
}

/**
 * Format relative time remaining (e.g., "2 days remaining", "Expired")
 */
function formatTimeRemaining(expiresAt: number): string {
  const now = Date.now()
  const diff = expiresAt - now

  if (diff <= 0) return "Expired"

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days > 0) return `${days} day${days === 1 ? "" : "s"} remaining`
  if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"} remaining`
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? "" : "s"} remaining`
  return "Expires soon"
}

/**
 * MyInvitationsView Component
 *
 * Renders a list of pending invitations for the current user to accept/decline.
 * Uses MCP domain for data operations.
 */
export function MyInvitationsView({ onInvitationResponse }: MyInvitationsViewProps) {
  // Get studioCore domain
  const { studioCore } = useDomains()

  // Get current user
  const { data: session } = useSession()
  const userEmail = session?.user?.email
  const userId = session?.user?.id

  // Data state
  const [invitations, setInvitations] = useState<MyInvitation[]>([])

  // UI state
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processingId, setProcessingId] = useState<string | null>(null)

  /**
   * Load invitations from MCP domain
   */
  const loadInvitations = useCallback(async () => {
    if (!studioCore?.invitationCollection || !userEmail) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Load invitations and workspaces from backend
      await studioCore.invitationCollection.query().toArray()
      await studioCore.workspaceCollection.query().toArray()

      // Get invitations for current user's email
      const userInvitations = studioCore.invitationCollection.findByEmail(userEmail)
      const pending = userInvitations.filter((i: any) => i.status === "pending")

      setInvitations(pending.map((i: any) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        isExpired: i.isExpired || Date.now() > i.expiresAt,
        workspace: i.workspace ? { id: i.workspace.id, name: i.workspace.name } : undefined,
        project: i.project ? { id: i.project.id, name: i.project.name } : undefined,
      })))
    } catch (err) {
      console.error("[MyInvitationsView] Failed to load invitations:", err)
      setError(err instanceof Error ? err.message : "Failed to load invitations")
    } finally {
      setIsLoading(false)
    }
  }, [userEmail, studioCore])

  // Load invitations on mount
  useEffect(() => {
    loadInvitations()
  }, [loadInvitations])

  /**
   * Handle accepting an invitation
   */
  const handleAccept = async (invitation: MyInvitation) => {
    if (!studioCore || !userId) return

    setProcessingId(invitation.id)
    setError(null)

    try {
      await studioCore.acceptInvitation(invitation.id, userId)

      // Remove from local state
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id))
      onInvitationResponse?.()
    } catch (err) {
      console.error("[MyInvitationsView] Failed to accept invitation:", err)
      setError(err instanceof Error ? err.message : "Failed to accept invitation")
    } finally {
      setProcessingId(null)
    }
  }

  /**
   * Handle declining an invitation
   */
  const handleDecline = async (invitation: MyInvitation) => {
    if (!studioCore || !userId) return

    setProcessingId(invitation.id)
    setError(null)

    try {
      await studioCore.declineInvitation(invitation.id, userId)

      // Remove from local state
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id))
      onInvitationResponse?.()
    } catch (err) {
      console.error("[MyInvitationsView] Failed to decline invitation:", err)
      setError(err instanceof Error ? err.message : "Failed to decline invitation")
    } finally {
      setProcessingId(null)
    }
  }

  /**
   * Get resource name for display
   */
  const getResourceName = (invitation: MyInvitation): string => {
    if (invitation.workspace) return invitation.workspace.name
    if (invitation.project) return invitation.project.name
    return "Unknown"
  }

  /**
   * Get resource type for display
   */
  const getResourceType = (invitation: MyInvitation): string => {
    if (invitation.workspace) return "workspace"
    if (invitation.project) return "project"
    return "resource"
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading invitations...</span>
      </div>
    )
  }

  // Error state (only show if not related to processing)
  if (error && !processingId) {
    return (
      <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm flex items-center gap-2">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    )
  }

  // Empty state
  if (invitations.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No pending invitations</p>
        <p className="text-sm">You don't have any pending invitations</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Error banner for processing errors */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {invitations.map((invitation) => {
        const isExpired = invitation.isExpired || Date.now() > invitation.expiresAt
        const isProcessing = processingId === invitation.id

        return (
          <div
            key={invitation.id}
            className={cn(
              "p-4 rounded-lg border bg-card",
              isExpired && "opacity-75"
            )}
          >
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                  <span className="font-semibold text-lg">
                    {getResourceName(invitation)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  You've been invited to join this {getResourceType(invitation)}
                </p>
              </div>
              <Badge variant={roleBadgeVariant[invitation.role] || "outline"}>
                {invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1)}
              </Badge>
            </div>

            {/* Time remaining */}
            <div className="flex items-center gap-2 mt-3 text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span
                className={cn(
                  isExpired ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {formatTimeRemaining(invitation.expiresAt)}
              </span>
              {isExpired && (
                <Badge variant="destructive" className="text-xs">
                  Expired
                </Badge>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 mt-4">
              <Button
                onClick={() => handleAccept(invitation)}
                disabled={isExpired || isProcessing}
                className="flex-1"
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    Accept
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleDecline(invitation)}
                disabled={isExpired || isProcessing}
                className="flex-1"
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <X className="h-4 w-4 mr-2" />
                    Decline
                  </>
                )}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
