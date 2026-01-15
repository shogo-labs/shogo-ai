/**
 * PendingInvitationsView Component
 * Task: task-pending-invitations-ui
 * Feature: member-management-invitation
 *
 * Displays pending invitations for an organization (admin/owner view).
 * Allows cancellation of pending invitations.
 *
 * Uses MCP domain (studioCore) for all data operations.
 */

import { useState, useEffect, useCallback } from "react"
import { Loader2, X, Clock, AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/auth/client"

/**
 * Invitation data from MCP domain
 */
interface Invitation {
  id: string
  email: string
  role: "owner" | "admin" | "member" | "viewer"
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled"
  expiresAt: number
  createdAt: number
  isExpired: boolean
}

/**
 * Props for PendingInvitationsView component
 */
export interface PendingInvitationsViewProps {
  /** Organization ID to fetch invitations for */
  orgId: string
  /** Callback when invitations change */
  onInvitationsChange?: () => void
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
 * Format relative time (e.g., "2 days ago", "in 3 hours")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = timestamp - now
  const absDiff = Math.abs(diff)

  const minutes = Math.floor(absDiff / (1000 * 60))
  const hours = Math.floor(absDiff / (1000 * 60 * 60))
  const days = Math.floor(absDiff / (1000 * 60 * 60 * 24))

  if (diff > 0) {
    // Future
    if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`
    if (hours > 0) return `in ${hours} hour${hours === 1 ? "" : "s"}`
    if (minutes > 0) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`
    return "soon"
  } else {
    // Past
    if (days > 0) return `${days} day${days === 1 ? "" : "s"} ago`
    if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"} ago`
    if (minutes > 0) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
    return "just now"
  }
}

/**
 * PendingInvitationsView Component
 *
 * Renders a list of pending invitations for organization admins/owners.
 * Uses MCP domain for data operations.
 */
export function PendingInvitationsView({
  orgId,
  onInvitationsChange,
}: PendingInvitationsViewProps) {
  // Get studioCore domain
  const { studioCore } = useDomains()

  // Get current user for cancel action
  const { data: session } = useSession()
  const currentUserId = session?.user?.id

  // Data state
  const [invitations, setInvitations] = useState<Invitation[]>([])

  // UI state
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [invitationToCancel, setInvitationToCancel] = useState<Invitation | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)

  /**
   * Load invitations from MCP domain
   */
  const loadInvitations = useCallback(async () => {
    if (!studioCore?.invitationCollection) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Load invitations from backend
      await studioCore.invitationCollection.query().toArray()
      await studioCore.organizationCollection.query().toArray()

      // Get invitations for this organization
      const orgInvitations = studioCore.invitationCollection.findForResource("organization", orgId)
      const pending = orgInvitations.filter((i: any) => i.status === "pending")

      setInvitations(pending.map((i: any) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        isExpired: i.isExpired || Date.now() > i.expiresAt,
      })))
    } catch (err) {
      console.error("[PendingInvitationsView] Failed to load invitations:", err)
      setError(err instanceof Error ? err.message : "Failed to load invitations")
    } finally {
      setIsLoading(false)
    }
  }, [orgId, studioCore])

  // Load invitations on mount and orgId change
  useEffect(() => {
    loadInvitations()
  }, [loadInvitations])

  /**
   * Handle invitation cancellation
   */
  const handleCancelInvitation = async () => {
    if (!invitationToCancel || !studioCore || !currentUserId) return

    setIsCancelling(true)

    try {
      await studioCore.cancelInvitation(invitationToCancel.id, currentUserId)

      // Update local state
      setInvitations((prev) => prev.filter((i) => i.id !== invitationToCancel.id))
      setInvitationToCancel(null)
      onInvitationsChange?.()
    } catch (err) {
      console.error("[PendingInvitationsView] Failed to cancel invitation:", err)
      setError(err instanceof Error ? err.message : "Failed to cancel invitation")
    } finally {
      setIsCancelling(false)
    }
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

  // Error state
  if (error) {
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
        <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No pending invitations</p>
        <p className="text-sm">Invite team members to get started</p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {invitations.map((invitation) => {
          const isExpired = invitation.isExpired || Date.now() > invitation.expiresAt

          return (
            <div
              key={invitation.id}
              className={cn(
                "flex items-center justify-between p-4 rounded-lg border",
                isExpired ? "bg-muted/50 opacity-75" : "bg-card"
              )}
            >
              {/* Invitation Info */}
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "font-medium",
                      isExpired && "line-through text-muted-foreground"
                    )}
                  >
                    {invitation.email}
                  </span>
                  <Badge variant={roleBadgeVariant[invitation.role] || "outline"}>
                    {invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1)}
                  </Badge>
                  {isExpired && (
                    <Badge variant="destructive" className="text-xs">
                      Expired
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  Sent {formatRelativeTime(invitation.createdAt)}
                  {!isExpired && (
                    <span className="ml-2">
                      - Expires {formatRelativeTime(invitation.expiresAt)}
                    </span>
                  )}
                </div>
              </div>

              {/* Cancel Button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInvitationToCancel(invitation)}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </div>
          )
        })}
      </div>

      {/* Cancel Invitation Confirmation Dialog */}
      <AlertDialog
        open={!!invitationToCancel}
        onOpenChange={(open) => !open && setInvitationToCancel(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Invitation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel the invitation for{" "}
              <strong>{invitationToCancel?.email}</strong>? They will no longer
              be able to join using this invitation link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCancelling}>Keep Invitation</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelInvitation}
              disabled={isCancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isCancelling ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cancelling...
                </>
              ) : (
                "Cancel Invitation"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
