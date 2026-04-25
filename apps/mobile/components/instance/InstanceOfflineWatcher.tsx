// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InstanceOfflineWatcher
 *
 * Phase 2 polish: surfaces a toast when the user's actively-selected remote
 * machine drops mid-conversation. Driven by the `instanceStatus` field on
 * `useActiveInstance()`, which polls /api/instances/:id every 15s.
 *
 * Mount once near the root, inside <ActiveInstanceProvider> and any toast
 * provider. Renders nothing.
 */

import { useEffect, useRef } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from '../ui/text'
import {
  useToast,
  Toast,
  ToastTitle,
  ToastDescription,
} from '../ui/toast'
import { useActiveInstance } from '../../contexts/active-instance'

export function InstanceOfflineWatcher() {
  const { instance, instanceStatus, clearInstance } = useActiveInstance()
  const toast = useToast()
  const lastWarnedRef = useRef<string | null>(null)
  const previousStatusRef = useRef<string>('unknown')

  useEffect(() => {
    if (!instance) {
      lastWarnedRef.current = null
      previousStatusRef.current = 'unknown'
      return
    }

    const prev = previousStatusRef.current
    previousStatusRef.current = instanceStatus

    const justWentOffline =
      instanceStatus === 'offline' &&
      prev !== 'offline' &&
      lastWarnedRef.current !== instance.instanceId

    if (!justWentOffline) return
    lastWarnedRef.current = instance.instanceId

    const id = `instance-offline-${instance.instanceId}`
    toast.show({
      id,
      placement: 'top',
      duration: 8000,
      render: ({ id: toastId }: { id: string }) => (
        <Toast nativeID={toastId} variant="outline" action="warning">
          <ToastTitle>Machine offline</ToastTitle>
          <ToastDescription>
            {instance.name} stopped heartbeating. Tool calls won't reach it
            until it reconnects.
          </ToastDescription>
          <View className="mt-2 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                clearInstance()
                toast.close(toastId)
              }}
              className="rounded-md bg-amber-500 px-3 py-1.5"
            >
              <Text className="text-xs font-medium text-amber-950">
                Continue in cloud
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => toast.close(toastId)}
              className="rounded-md border border-border px-3 py-1.5"
            >
              <Text className="text-xs font-medium text-foreground">Wait</Text>
            </Pressable>
          </View>
        </Toast>
      ),
    })
  }, [instance, instanceStatus, toast, clearInstance])

  useEffect(() => {
    if (instanceStatus === 'online' || instanceStatus === 'heartbeat') {
      lastWarnedRef.current = null
    }
  }, [instanceStatus])

  return null
}
