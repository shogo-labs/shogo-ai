// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ComponentType, ReactNode } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { Button, cn } from '@shogo/shared-ui/primitives'
import type { PermissionState } from '../../../lib/desktop-bridge'

export interface PermissionRowProps {
  id: string
  title: string
  description?: string
  icon: ComponentType<{ size?: number; className?: string }>
  state: PermissionState
  /** True while the native prompt / settings round-trip is in flight. */
  busy?: boolean
  /** Replaces the default "Allow" action label (e.g. "Open Settings"). */
  actionLabel?: string
  onAllow: () => void
  /** Extra content under the description (relaunch hints, etc.). */
  children?: ReactNode
  className?: string
}

/** One permission: icon, copy, and either an Allow button or a granted check. */
export function PermissionRow({
  id,
  title,
  description,
  icon: Icon,
  state,
  busy,
  actionLabel = 'Allow',
  onAllow,
  children,
  className,
}: PermissionRowProps) {
  const granted = state === 'granted'
  return (
    <View
      testID={`permission-row-${id}`}
      className={cn('flex-row items-center gap-4 px-5 py-4', className)}
    >
      <View className="h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
        <Icon size={20} className="text-foreground" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        {description ? (
          <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</Text>
        ) : null}
        {children}
      </View>
      {granted ? (
        <View
          testID={`permission-granted-${id}`}
          accessibilityLabel={`${title} allowed`}
          className="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-500"
        >
          <Check size={14} strokeWidth={3} className="text-white" />
        </View>
      ) : state === 'unsupported' ? null : (
        <Button
          testID={`permission-allow-${id}`}
          size="sm"
          className="rounded-full px-5"
          disabled={busy}
          onPress={onAllow}
          accessibilityLabel={`Allow ${title}`}
        >
          {busy ? <ActivityIndicator size="small" className="text-primary-foreground" /> : actionLabel}
        </Button>
      )}
    </View>
  )
}
