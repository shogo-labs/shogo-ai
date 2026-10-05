// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { usePresence } from '../../hooks/usePresence'
import type { PresenceStatus } from '../../lib/team-chat-api'

const LABELS: Record<PresenceStatus, string> = { active: 'Active', away: 'Away', offline: 'Offline' }

export function presenceLabel(status: PresenceStatus | null): string {
  return LABELS[status ?? 'offline']
}

/**
 * Filled green when active, a hollow ring when away or offline. `badge`
 * sits on an avatar's corner and hides unless the person is active or away.
 */
export function PresenceDot({
  userId,
  workspaceId,
  size = 8,
  badge = false,
  className,
}: {
  userId: string | null | undefined
  workspaceId?: string | null
  size?: number
  badge?: boolean
  className?: string
}) {
  const status = usePresence(workspaceId, userId)
  if (!userId || (badge && status !== 'active' && status !== 'away')) return null
  return (
    <View
      accessibilityLabel={presenceLabel(status)}
      testID={`presence-${status ?? 'offline'}`}
      style={{ width: size, height: size }}
      className={cn(
        'rounded-full',
        status === 'active'
          ? cn('bg-emerald-500', badge && 'border-2 border-background')
          : 'border-[1.5px] border-muted-foreground bg-background',
        badge && 'absolute -bottom-0.5 -right-0.5',
        className,
      )}
    />
  )
}
