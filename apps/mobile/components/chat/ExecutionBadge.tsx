// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ExecutionBadge
 *
 * Small banner that surfaces the currently-selected execution environment.
 * Only renders when a non-Cloud (remote instance) is active, so the default
 * Cloud mode stays visually quiet.
 *
 * Consumes `useActiveInstance()` — zero extra plumbing.
 */
import { View, Text, Pressable } from "react-native"
import { Zap, X } from "lucide-react-native"
import { useActiveInstance } from "../../contexts/active-instance"

export function ExecutionBadge() {
  const { instance, clearInstance } = useActiveInstance()
  if (!instance) return null

  return (
    <View className="mx-3 mb-2 flex-row items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1.5">
      <Zap className="h-3 w-3 text-emerald-600" size={12} />
      <Text className="flex-1 text-[11px] text-emerald-700 leading-tight">
        Running on <Text className="font-semibold">{instance.name}</Text>
        <Text className="text-emerald-700/70"> · {instance.hostname}</Text>
      </Text>
      <Pressable
        onPress={clearInstance}
        accessibilityLabel="Disconnect from remote instance"
        className="h-4 w-4 items-center justify-center rounded hover:bg-emerald-500/20"
      >
        <X className="h-3 w-3 text-emerald-700" size={11} />
      </Pressable>
    </View>
  )
}
