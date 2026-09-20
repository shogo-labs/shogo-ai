// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-time, dismissible banner offering the free "create your personal
 * space" flow to users who don't have a `kind: 'personal'` workspace yet.
 *
 * This mainly targets pre-existing users whose original signup workspace
 * was mis-backfilled to `kind: 'team'` by the personal-workspace-foundation
 * migration — it only flipped slug-matching workspaces with *zero projects*
 * to `kind: 'personal'`, so anyone who already had projects kept
 * `kind: 'team'` and has no way to get a personal/companion workspace
 * through the normal (count-gated) create flow. See
 * `POST /api/workspaces/personal` and `WorkspaceMenuSectionProps.hasPersonalWorkspace`
 * for the other half of this flow (the workspace-switcher CTA).
 *
 * Dismissal is a per-device, AsyncStorage-backed flag keyed by user id
 * (there's no personal workspace id to key by yet, unlike
 * `useWelcomeMessage.ts`, which this otherwise mirrors).
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Sparkles, X } from 'lucide-react-native'

const STORAGE_KEY_PREFIX = 'shogo:personal-space-offer-dismissed:'

function useDismissed(userId: string | undefined): { dismissed: boolean; dismiss: () => void } {
  // Default to dismissed (hidden) until we've confirmed the device hasn't
  // seen this before — avoids a one-frame flash for users who already
  // dismissed it.
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    AsyncStorage.getItem(STORAGE_KEY_PREFIX + userId)
      .then((seen) => {
        if (!cancelled) setDismissed(seen === 'true')
      })
      .catch(() => {
        // Storage unavailable — default to dismissed rather than risk
        // showing the banner on every open.
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const dismiss = useCallback(() => {
    setDismissed(true)
    if (!userId) return
    AsyncStorage.setItem(STORAGE_KEY_PREFIX + userId, 'true').catch(() => {
      // Non-fatal: worst case the banner reappears next open.
    })
  }, [userId])

  return { dismissed, dismiss }
}

export function CreatePersonalSpaceBanner({
  userId,
  onCreate,
}: {
  userId: string | undefined
  onCreate: () => void | Promise<void>
}) {
  const { dismissed, dismiss } = useDismissed(userId)
  const [creating, setCreating] = useState(false)

  const handleCreate = useCallback(async () => {
    if (creating) return
    setCreating(true)
    try {
      await onCreate()
      dismiss()
    } finally {
      setCreating(false)
    }
  }, [creating, dismiss, onCreate])

  if (dismissed) return null

  return (
    <View className="w-full flex-row items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4">
      <Sparkles size={18} className="mt-0.5 text-primary" />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground">
          Get your own personal space
        </Text>
        <Text className="mt-1 text-sm leading-5 text-muted-foreground">
          A free companion space that tracks goals and checks in with you — separate from your team's projects.
        </Text>
        <Pressable
          onPress={handleCreate}
          disabled={creating}
          accessibilityRole="button"
          accessibilityLabel="Create personal space"
          className="mt-3 flex-row items-center gap-2 self-start rounded-md bg-primary px-3 py-1.5 active:opacity-80"
        >
          {creating ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-sm font-medium text-primary-foreground">
              Create it — it's free
            </Text>
          )}
        </Pressable>
      </View>
      <Pressable
        onPress={dismiss}
        accessibilityLabel="Dismiss"
        className="h-7 w-7 items-center justify-center rounded-full active:bg-primary/10"
      >
        <X size={15} className="text-muted-foreground" />
      </Pressable>
    </View>
  )
}
