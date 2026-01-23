/**
 * NotificationItem Component
 *
 * Displays an individual notification with mark-as-read action.
 * For invitation_pending notifications, shows Accept/Decline buttons.
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import {
  Loader2,
  Check,
  X,
  Mail,
  UserPlus,
  UserMinus,
  Building2,
  Circle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useDomains } from "@shogo/app-core"
import { useSession } from "@/auth/client"
import type { Notification } from "./NotificationList"

/**
 * Props for NotificationItem component
 */
export interface NotificationItemProps {
  notification: Notification
  /** Callback after action completes */
  onAction?: () => void
}

/**
 * Get icon for notification type
 */
function getNotificationIcon(type: Notification["type"]) {
  switch (type) {
    case "invitation_pending":
      return Mail
    case "invitation_accepted":
      return Check
    case "member_joined":
      return UserPlus
    case "member_left":
      return UserMinus
    case "workspace_updated":
      return Building2
    default:
      return Circle
  }
}

/**
 * Format relative time (e.g., "2 hours ago", "yesterday")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

/**
 * NotificationItem Component
 *
 * Renders a single notification with actions based on type.
 */
export const NotificationItem = observer(function NotificationItem({
  notification,
  onAction,
}: NotificationItemProps) {
  const { studioCore } = useDomains()
  const { data: session } = useSession()
  const userId = session?.user?.id

  const [isProcessing, setIsProcessing] = useState(false)
  const [processingAction, setProcessingAction] = useState<"accept" | "decline" | null>(null)

  const Icon = getNotificationIcon(notification.type)
  const isUnread = notification.isUnread

  /**
   * Mark notification as read
   */
  const handleMarkRead = async () => {
    if (!studioCore || !isUnread) return

    try {
      await studioCore.markNotificationRead(notification.id)
      onAction?.()
    } catch (error) {
      console.error("[NotificationItem] Failed to mark as read:", error)
    }
  }

  /**
   * Accept invitation (for invitation_pending notifications)
   */
  const handleAcceptInvitation = async () => {
    if (!studioCore || !userId) return

    const invitationId = notification.metadata?.invitationId
    if (!invitationId) return

    setIsProcessing(true)
    setProcessingAction("accept")

    try {
      await studioCore.acceptInvitation(invitationId, userId)
      await studioCore.markNotificationRead(notification.id)
      onAction?.()
    } catch (error: any) {
      console.error("[NotificationItem] Failed to accept invitation:", error)
    } finally {
      setIsProcessing(false)
      setProcessingAction(null)
    }
  }

  /**
   * Decline invitation (for invitation_pending notifications)
   */
  const handleDeclineInvitation = async () => {
    if (!studioCore) return

    const invitationId = notification.metadata?.invitationId
    if (!invitationId) return

    setIsProcessing(true)
    setProcessingAction("decline")

    try {
      await studioCore.declineInvitation(invitationId)
      await studioCore.markNotificationRead(notification.id)
      onAction?.()
    } catch (error: any) {
      console.error("[NotificationItem] Failed to decline invitation:", error)
    } finally {
      setIsProcessing(false)
      setProcessingAction(null)
    }
  }

  return (
    <div
      className={cn(
        "flex gap-3 p-4 transition-colors hover:bg-muted/50",
        isUnread && "bg-muted/30"
      )}
      onClick={handleMarkRead}
    >
      {/* Icon */}
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUnread ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      {/* Content */}
      <div className="flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className={cn("text-sm", isUnread && "font-medium")}>{notification.title}</p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(notification.createdAt)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{notification.message}</p>

        {/* Invitation actions */}
        {notification.type === "invitation_pending" && notification.metadata?.invitationId && (
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              variant="default"
              onClick={(e) => {
                e.stopPropagation()
                handleAcceptInvitation()
              }}
              disabled={isProcessing}
              className="h-7 px-3 text-xs"
            >
              {isProcessing && processingAction === "accept" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Check className="mr-1 h-3 w-3" />
              )}
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation()
                handleDeclineInvitation()
              }}
              disabled={isProcessing}
              className="h-7 px-3 text-xs"
            >
              {isProcessing && processingAction === "decline" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <X className="mr-1 h-3 w-3" />
              )}
              Decline
            </Button>
          </div>
        )}
      </div>

      {/* Unread indicator */}
      {isUnread && (
        <div className="flex items-center">
          <div className="h-2 w-2 rounded-full bg-primary" />
        </div>
      )}
    </div>
  )
})
