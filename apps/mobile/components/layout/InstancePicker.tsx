// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InstancePicker — Sidebar component for selecting which Shogo instance to
 * control. When a remote instance is selected, the normal project interface
 * transparently routes agent traffic through the cloud tunnel proxy.
 *
 * Business logic is delegated to the shared `useInstancePicker` hook from
 * `@shogo/shared-app/hooks`. This component provides the mobile-specific
 * Popover UI and auth-aware fetch adapter.
 */

import { useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native'
import {
  Monitor,
  Laptop,
  Check,
  ChevronDown,
  ChevronRight,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { useActiveInstance } from '../../contexts/active-instance'
import { useInstancePicker, type Instance } from '@shogo/shared-app/hooks'
import { API_URL } from '../../lib/api'
import { authClient } from '../../lib/auth-client'

function getAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

function StatusDot({ status }: { status: Instance['status'] }) {
  const color =
    status === 'online' ? 'bg-green-500'
    : status === 'heartbeat' ? 'bg-yellow-500'
    : 'bg-muted-foreground/40'

  return <View className={cn('h-2 w-2 rounded-full', color)} />
}

interface InstancePickerProps {
  workspaceId: string | undefined
  collapsed?: boolean
  onNavPress?: () => void
}

export function InstancePicker({ workspaceId, collapsed }: InstancePickerProps) {
  const { instance: activeInstance, setInstance, clearInstance } = useActiveInstance()

  const fetchOptions: RequestInit = useMemo(
    () => ({
      credentials: Platform.OS === 'web' ? ('include' as const) : ('omit' as const),
      headers: { ...getAuthHeaders() },
    }),
    [],
  )

  const picker = useInstancePicker({
    workspaceId,
    apiUrl: API_URL ?? '',
    activeInstance,
    setInstance,
    clearInstance,
    fetchOptions,
  })

  const {
    instances,
    loading,
    connecting,
    connectError,
    isOpen,
    open,
    close,
    select,
    disconnect,
  } = picker

  const label = activeInstance ? activeInstance.name : 'This device'
  const StatusIcon = activeInstance ? Laptop : Monitor

  const popoverBody = (
    <View className="py-2">
      <Text className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Controlling
      </Text>

      <Pressable
        onPress={disconnect}
        className="flex-row items-center gap-3 px-4 py-2.5 active:bg-muted"
      >
        <Monitor size={16} className="text-muted-foreground" />
        <Text className="text-sm text-foreground flex-1">This device</Text>
        {!activeInstance && <Check size={16} className="text-primary" />}
      </Pressable>

      <View className="h-px bg-border mx-3 my-1" />

      <Text className="px-4 pt-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Remote instances
      </Text>

      {loading && (
        <View className="px-4 py-3 items-center">
          <ActivityIndicator size="small" />
        </View>
      )}

      {!loading && instances.length === 0 && (
        <View className="px-4 py-3 gap-2">
          <View className="gap-2">
            <View className="flex-row items-start gap-2">
              <Text className="text-xs font-bold text-primary w-4">1</Text>
              <Text className="text-xs text-muted-foreground flex-1">Install Shogo Desktop on your computer</Text>
            </View>
            <View className="flex-row items-start gap-2">
              <Text className="text-xs font-bold text-primary w-4">2</Text>
              <Text className="text-xs text-muted-foreground flex-1">Connect to Shogo Cloud using an API key</Text>
            </View>
            <View className="flex-row items-start gap-2">
              <Text className="text-xs font-bold text-primary w-4">3</Text>
              <Text className="text-xs text-muted-foreground flex-1">Your instance will appear here once connected</Text>
            </View>
          </View>
        </View>
      )}

      {!loading && instances.map((inst) => {
        const isActive = activeInstance?.instanceId === inst.id
        const isConnecting = connecting === inst.id

        return (
          <Pressable
            key={inst.id}
            onPress={() => select(inst)}
            disabled={isConnecting}
            className={cn(
              'flex-row items-center gap-3 px-4 py-2.5 active:bg-muted',
              isConnecting && 'opacity-50',
            )}
          >
            <Laptop size={16} className="text-muted-foreground" />
            <View className="flex-1 min-w-0">
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {inst.name}
              </Text>
              <View className="flex-row items-center gap-1.5 mt-0.5">
                <StatusDot status={inst.status} />
                <Text className="text-[11px] text-muted-foreground">
                  {inst.status === 'online' ? 'Online' : inst.status === 'heartbeat' ? 'Standby' : 'Offline'}
                </Text>
              </View>
            </View>
            {isConnecting && <ActivityIndicator size="small" />}
            {isActive && !isConnecting && <Check size={16} className="text-primary" />}
          </Pressable>
        )
      })}

      {connectError && (
        <View className="px-4 py-2">
          <Text className="text-xs text-destructive text-center">
            {connectError}
          </Text>
        </View>
      )}

    </View>
  )

  return (
    <Popover
      placement="right"
      size="sm"
      isOpen={isOpen}
      onOpen={open}
      onClose={close}
      trigger={(triggerProps) =>
        collapsed ? (
          <Pressable
            {...triggerProps}
            accessibilityLabel="Instance selector"
            className={cn(
              'items-center justify-center rounded-md px-2 py-2',
              activeInstance ? 'bg-primary/10' : 'active:bg-accent/50',
            )}
          >
            <StatusIcon
              size={16}
              className={activeInstance ? 'text-primary' : 'text-muted-foreground'}
            />
          </Pressable>
        ) : (
          <Pressable
            {...triggerProps}
            className={cn(
              'flex-row items-center gap-3 rounded-md px-3 py-2',
              activeInstance ? 'bg-primary/10' : 'active:bg-accent/50',
            )}
          >
            <StatusIcon
              size={16}
              className={activeInstance ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text
              className={cn(
                'text-sm flex-1',
                activeInstance ? 'text-primary font-medium' : 'text-muted-foreground',
              )}
              numberOfLines={1}
            >
              {label}
            </Text>
            {isOpen ? (
              <ChevronDown size={14} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={14} className="text-muted-foreground" />
            )}
          </Pressable>
        )
      }
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0">
        <PopoverBody>
          {popoverBody}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
