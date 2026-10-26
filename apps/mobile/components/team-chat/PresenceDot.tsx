// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View } from 'react-native'
import { Headphones } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useInHuddle, usePresence } from '../../hooks/usePresence'
import type { PresenceStatus } from '../../lib/team-chat-api'

const LABELS: Record<PresenceStatus, string> = { active: 'Active', away: 'Away', offline: 'Offline' }

export function presenceLabel(status: PresenceStatus | null): string {
  return LABELS[status ?? 'offline']
}

/**
 * Filled green when active, a hollow ring when away or offline. `badge` sits
 * on an avatar's corner and hides unless the person is active or away.
 *
 * Someone in a huddle shows headphones instead of the dot: it is the more
 * useful thing to know about them, so it wins, and unlike the dot it is never
 * hidden — being on a call is worth showing even if their socket has lapsed.
 */
export function PresenceDot({
  userId,
  workspaceId,
  size = 8,
  badge = false,
  className,
  ringClassName = 'border-background',
}: {
  userId: string | null | undefined
  workspaceId?: string | null
  size?: number
  badge?: boolean
  className?: string
  /** Ring color for a badge sitting on a surface other than the page background. */
  ringClassName?: string
}) {
  const status = usePresence(workspaceId, userId)
  const inHuddle = useInHuddle(workspaceId, userId)
  if (!userId) return null
  if (inHuddle) {
    return (
      <Headphones
        accessibilityLabel="In a huddle"
        testID="in-huddle"
        size={size + 5}
        className={cn('text-emerald-600', badge && 'absolute -bottom-0.5 -right-0.5', className)}
      />
    )
  }
  if (badge && status !== 'active' && status !== 'away') return null
  return (
    <View
      accessibilityLabel={presenceLabel(status)}
      testID={`presence-${status ?? 'offline'}`}
      style={{ width: size, height: size }}
      className={cn(
        'rounded-full',
        status === 'active'
          ? cn('bg-emerald-500', badge && 'border-2', badge && ringClassName)
          : 'border-[1.5px] border-muted-foreground bg-background',
        badge && 'absolute -bottom-0.5 -right-0.5',
        className,
      )}
    />
  )
}
