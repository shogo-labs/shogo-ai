// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MachineWorkspaceBanner (SHO-185, AC4)
 *
 * The one line a machine workspace shows above the composer when the Mac is not
 * answering: "<machine> is offline — last synced 12m ago" or "Waking <machine>…".
 * The state comes from `machineWorkspaceState`, which every machine-workspace
 * request reports into, so a read that came back and a write that was refused
 * cannot disagree about whether the machine is up.
 *
 * While the state is `waking` it retries the last failed request on the wait the
 * server asked for (capped at a minute by the store) and stops on its own once
 * the request lands.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { CloudOff, RefreshCw } from 'lucide-react-native'
import { Text } from '../ui/text'
import {
  type MachineWorkspaceCondition,
  type MachineWorkspaceView,
  describeMachineWorkspace,
  machineWorkspaceState,
} from '@shogo/shared-app/services'

/** Subscribe to the machine's state; every request reports into it. */
export function useMachineWorkspaceCondition(): MachineWorkspaceCondition {
  const [condition, setCondition] = useState<MachineWorkspaceCondition>(() => machineWorkspaceState.get())

  useEffect(() => {
    const unsubscribe = machineWorkspaceState.subscribe(setCondition)
    // A state set between render and subscribe would otherwise be missed.
    setCondition(machineWorkspaceState.get())
    return unsubscribe
  }, [])

  return condition
}

/**
 * The banner's props, as one value a screen can read for itself — the chat uses
 * this to disable the composer without waiting for the banner to render.
 */
export function useMachineWorkspace(options: {
  machineName?: string | null
  lastSyncedAt?: string | null
  onRetry?: () => void | Promise<void>
}): MachineWorkspaceView & { retrying: boolean } {
  const condition = useMachineWorkspaceCondition()
  const [retrying, setRetrying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onRetryRef = useRef(options.onRetry)
  onRetryRef.current = options.onRetry

  const view = describeMachineWorkspace(condition, {
    machineName: options.machineName,
    lastSyncedAt: options.lastSyncedAt,
  })

  const retry = useCallback(async () => {
    if (!onRetryRef.current) return
    setRetrying(true)
    try {
      await onRetryRef.current()
    } finally {
      setRetrying(false)
    }
  }, [])

  // Only the waking state retries by itself: an offline machine will not answer
  // in a few seconds, and hammering it is what made the API log unreadable.
  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (condition.kind !== 'waking' || !options.onRetry) return
    timer.current = setTimeout(() => {
      void retry()
    }, condition.retryAfterMs)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [condition, retry, options.onRetry])

  return { ...view, retrying }
}

export function MachineWorkspaceBanner({
  machineName,
  lastSyncedAt,
  onRetry,
}: {
  machineName?: string | null
  lastSyncedAt?: string | null
  onRetry?: () => void | Promise<void>
}) {
  const view = useMachineWorkspace({ machineName, lastSyncedAt, onRetry })

  if (!view.banner) return null

  const waking = view.tone === 'waking'

  return (
    <View
      accessibilityRole="alert"
      testID="machine-workspace-banner"
      className={
        waking
          ? 'flex-row items-center gap-2 border-b border-border bg-muted/50 px-4 py-2'
          : 'flex-row items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2'
      }
    >
      {waking ? (
        <RefreshCw size={14} className="text-muted-foreground" />
      ) : (
        <CloudOff size={14} className="text-amber-600 dark:text-amber-300" />
      )}
      <Text className="flex-1 text-xs text-foreground" numberOfLines={2}>
        {view.banner}
      </Text>
      {onRetry && !waking ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={() => void onRetry()}
          className="rounded-md border border-border px-2 py-1"
        >
          <Text className="text-xs font-medium text-foreground">Try again</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
