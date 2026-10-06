// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace compute-budget messaging for the project screen.
 *
 * A workspace's instance size is memory shared by all of its running
 * projects. When opening a project puts others to sleep to make room, the
 * user gets a one-time toast saying how many are running and which went to
 * sleep; when the open is refused because the rest are busy, the recovery
 * card shows the reason. Both offer an upgrade where purchases are allowed.
 */

import { useEffect } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Moon, X as XIcon, Zap } from 'lucide-react-native'
import type { WorkspaceBudgetMessage } from '@shogo/shared-app/hooks'
import { Toast, ToastDescription, ToastTitle, useToast } from '../ui/toast'

// Compute purchases aren't offered in the iOS app (see settings-tabs.ts).
const CAN_PURCHASE_COMPUTE = Platform.OS !== 'ios'

function useOpenComputeUpgrade() {
  const router = useRouter()
  return () => router.push('/settings?tab=compute' as any)
}

/** Show `notice` once as a toast, then clear it. */
export function useWorkspaceBudgetToast(notice: WorkspaceBudgetMessage | null, dismiss: () => void) {
  const toast = useToast()
  const openUpgrade = useOpenComputeUpgrade()

  useEffect(() => {
    if (!notice) return
    const showUpgrade = notice.canUpgrade && CAN_PURCHASE_COMPUTE
    toast.show({
      id: `workspace-budget-${Date.now()}`,
      placement: 'top',
      duration: 15_000,
      render: ({ id }: { id: string }) => (
        <Toast nativeID={id} variant="solid" action="warning">
          <View className="flex-row items-start gap-2">
            <View className="mt-0.5">
              <Moon size={16} className="text-typography-0" />
            </View>
            <View className="flex-1">
              <ToastTitle>
                {notice.projects.length === 1
                  ? '1 project was put to sleep'
                  : `${notice.projects.length} projects were put to sleep`}
              </ToastTitle>
              <ToastDescription>{notice.message}</ToastDescription>
            </View>
          </View>
          <View className="mt-2 flex-row gap-2">
            {showUpgrade && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Upgrade instance size"
                onPress={() => {
                  toast.close(id)
                  openUpgrade()
                }}
                className="flex-row items-center gap-1.5 rounded-md bg-white/95 px-3 py-1.5 active:opacity-80"
              >
                <Zap size={12} className="text-warning-700" />
                <Text className="text-xs font-semibold text-warning-700">Upgrade</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => toast.close(id)}
              className="flex-row items-center gap-1 rounded-md border border-white/30 px-3 py-1.5 active:opacity-80"
            >
              <XIcon size={12} className="text-typography-0" />
              <Text className="text-xs font-medium text-typography-0">Dismiss</Text>
            </Pressable>
          </View>
        </Toast>
      ),
    })
    dismiss()
  }, [notice])
}

/** Body of the recovery card when the open was refused for lack of workspace compute. */
export function WorkspaceCapacityCard({
  capacity,
  onRetry,
  onBack,
}: {
  capacity: WorkspaceBudgetMessage
  onRetry: () => void
  onBack: () => void
}) {
  const openUpgrade = useOpenComputeUpgrade()
  const showUpgrade = capacity.canUpgrade && CAN_PURCHASE_COMPUTE
  return (
    <View className="w-full max-w-sm gap-3 items-center">
      <Text className="text-foreground text-base font-semibold text-center">
        Your workspace is out of room for running projects
      </Text>
      <Text className="text-muted-foreground text-sm text-center">{capacity.message}</Text>
      <View className="flex-row flex-wrap gap-2 mt-2 justify-center">
        <Pressable
          onPress={onRetry}
          className="px-4 py-2 rounded-md border border-border active:bg-muted"
          accessibilityLabel="Try opening this project again"
        >
          <Text className="text-foreground text-sm font-medium">Try again</Text>
        </Pressable>
        <Pressable
          onPress={onBack}
          className="px-4 py-2 rounded-md border border-border active:bg-muted"
          accessibilityLabel="Go back to projects list"
        >
          <Text className="text-foreground text-sm font-medium">Go back</Text>
        </Pressable>
        {showUpgrade && (
          <Pressable
            onPress={openUpgrade}
            className="px-4 py-2 rounded-md bg-primary active:bg-primary/80"
            accessibilityLabel="Upgrade instance size"
          >
            <Text className="text-primary-foreground text-sm font-medium">Upgrade</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}
