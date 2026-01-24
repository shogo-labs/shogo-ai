/**
 * NotificationBanner Component
 *
 * Displays an unread notification count badge that opens the notification list.
 * Uses MCP domain (studioCore) for notification data.
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { Bell } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/contexts/SessionProvider"
import { NotificationList } from "./NotificationList"

/**
 * NotificationBanner Component
 *
 * Shows a bell icon with unread count badge.
 * Clicking opens a popover with the notification list.
 */
export const NotificationBanner = observer(function NotificationBanner() {
  const { studioCore } = useDomains()
  const { data: session } = useSession()
  const userId = session?.user?.id

  const [isOpen, setIsOpen] = useState(false)

  // Get unread count from domain
  const unreadCount = userId
    ? studioCore?.notificationCollection?.unreadCountForUser?.(userId) ?? 0
    : 0

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          <span className="sr-only">
            {unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <NotificationList onClose={() => setIsOpen(false)} />
      </PopoverContent>
    </Popover>
  )
})
