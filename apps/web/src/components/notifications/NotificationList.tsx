/**
 * NotificationList Component
 *
 * Displays all notifications for the current user, sorted by date (newest first).
 * Uses MCP domain (studioCore) for notification data.
 */

import { useState, useEffect, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { Loader2, Bell, CheckCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/auth/client"
import { NotificationItem } from "./NotificationItem"

/**
 * Notification data from MCP domain
 */
export interface Notification {
  id: string
  userId: string
  type: "invitation_pending" | "invitation_accepted" | "member_joined" | "member_left" | "workspace_updated"
  title: string
  message: string
  metadata?: Record<string, any>
  actionUrl?: string
  readAt?: number
  createdAt: number
  isUnread: boolean
}

/**
 * Props for NotificationList component
 */
export interface NotificationListProps {
  /** Callback when list should close (e.g., after action) */
  onClose?: () => void
}

/**
 * NotificationList Component
 *
 * Renders a scrollable list of notifications for the current user.
 */
export const NotificationList = observer(function NotificationList({
  onClose,
}: NotificationListProps) {
  const { studioCore } = useDomains()
  const { data: session } = useSession()
  const userId = session?.user?.id

  const [isLoading, setIsLoading] = useState(true)
  const [notifications, setNotifications] = useState<Notification[]>([])

  /**
   * Load notifications from domain
   */
  const loadNotifications = useCallback(async () => {
    if (!userId || !studioCore) {
      setIsLoading(false)
      return
    }

    try {
      // Load all notifications
      await studioCore.notificationCollection.loadAll()

      // Get notifications for current user
      const userNotifications = studioCore.notificationCollection.forUser(userId) || []

      // Sort by createdAt descending (newest first)
      const sorted = [...userNotifications].sort((a, b) => b.createdAt - a.createdAt)

      setNotifications(sorted)
    } catch (error) {
      console.error("[NotificationList] Failed to load notifications:", error)
    } finally {
      setIsLoading(false)
    }
  }, [userId, studioCore])

  useEffect(() => {
    loadNotifications()
  }, [loadNotifications])

  /**
   * Mark all notifications as read
   */
  const handleMarkAllRead = async () => {
    if (!studioCore) return

    try {
      const unread = notifications.filter((n) => n.isUnread)
      for (const notification of unread) {
        await studioCore.markNotificationRead(notification.id)
      }
      await loadNotifications()
    } catch (error) {
      console.error("[NotificationList] Failed to mark all as read:", error)
    }
  }

  /**
   * Handle notification action (accept/decline invitation, etc.)
   */
  const handleNotificationAction = async () => {
    await loadNotifications()
    onClose?.()
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (notifications.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <Bell className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">No notifications</p>
      </div>
    )
  }

  const hasUnread = notifications.some((n) => n.isUnread)

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="font-semibold">Notifications</h3>
        {hasUnread && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1 text-xs"
            onClick={handleMarkAllRead}
          >
            <CheckCircle className="mr-1 h-3 w-3" />
            Mark all read
          </Button>
        )}
      </div>

      {/* List */}
      <ScrollArea className="max-h-[400px]">
        <div className="divide-y">
          {notifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onAction={handleNotificationAction}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
})
