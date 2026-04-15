// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InstancePickerPopover — Cross-platform UI component for selecting which
 * Shogo instance to control. Designed to sit in any sidebar or toolbar on
 * mobile, web (Expo), or desktop (Electron).
 *
 * This component renders a trigger button and a dropdown list of instances.
 * It delegates all business logic to the `useInstancePicker` hook from
 * `@shogo/shared-app/hooks`.
 *
 * Platform support:
 *  - React Native (iOS, Android)
 *  - Expo web
 *  - Electron (via Expo web export)
 *  - Standalone React web (via react-native-web)
 */

import { View, Text, Pressable, ActivityIndicator, Modal, ScrollView } from 'react-native'
import {
  Monitor,
  Laptop,
  Check,
  ChevronDown,
  ChevronRight,
} from 'lucide-react-native'
import { cn } from '../primitives/cn'
import type { Instance, UseInstancePickerResult } from '@shogo/shared-app/hooks'
import type { ActiveInstance } from '@shogo/shared-app/hooks'

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusDot({ status }: { status: Instance['status'] }) {
  const color =
    status === 'online' ? 'bg-green-500'
    : status === 'heartbeat' ? 'bg-yellow-500'
    : 'bg-muted-foreground/40'

  return <View className={cn('h-2 w-2 rounded-full', color)} />
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface InstancePickerPopoverProps {
  picker: UseInstancePickerResult
  activeInstance: ActiveInstance | null
  collapsed?: boolean
  workspaceId?: string
}

// ─── Popover body (shared between collapsed/expanded triggers) ──────────────

function InstancePickerBody({
  picker,
  activeInstance,
}: Omit<InstancePickerPopoverProps, 'collapsed' | 'workspaceId'>) {
  const { instances, loading, connecting, connectError, select, disconnect } = picker

  return (
    <ScrollView className="py-2 max-h-80" bounces={false}>
      <Text className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Controlling
      </Text>

      {/* Local / this device */}
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
            {(['Install Shogo Desktop on your computer',
              'Connect to Shogo Cloud using an API key',
              'Your instance will appear here once connected',
            ] as const).map((text, i) => (
              <View key={i} className="flex-row items-start gap-2">
                <Text className="text-xs font-bold text-primary w-4">{i + 1}</Text>
                <Text className="text-xs text-muted-foreground flex-1">{text}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {!loading &&
        instances.map((inst) => {
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
                    {inst.status === 'online'
                      ? 'Online'
                      : inst.status === 'heartbeat'
                        ? 'Standby'
                        : 'Offline'}
                  </Text>
                </View>
              </View>
              {isConnecting && <ActivityIndicator size="small" />}
              {isActive && !isConnecting && (
                <Check size={16} className="text-primary" />
              )}
            </Pressable>
          )
        })}

      {connectError && (
        <View className="px-4 py-2">
          <Text className="text-xs text-destructive text-center">{connectError}</Text>
        </View>
      )}

    </ScrollView>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export function InstancePickerPopover({
  picker,
  activeInstance,
  collapsed,
}: InstancePickerPopoverProps) {
  const { isOpen, open, close } = picker
  const label = activeInstance ? activeInstance.name : 'This device'
  const StatusIcon = activeInstance ? Laptop : Monitor

  const trigger = collapsed ? (
    <Pressable
      onPress={open}
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
      onPress={open}
      accessibilityLabel="Instance selector"
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

  return (
    <View>
      {trigger}

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable className="flex-1 bg-black/30" onPress={close}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-card border border-border rounded-xl shadow-2xl w-[280px] mt-24 ml-16 max-h-[480px]"
          >
            <InstancePickerBody
              picker={picker}
              activeInstance={activeInstance}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}
