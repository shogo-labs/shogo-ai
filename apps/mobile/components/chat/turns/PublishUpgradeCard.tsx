// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shown in place of the `publish` tool row when the Pro-plan gate refused the
 * publish (`code: "plan_not_allowed"`), so the user has a way forward instead
 * of only the agent's explanation.
 */

import { Pressable, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { Globe } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"

export { isPublishPlanGate } from "./publish-plan-gate"

export function PublishUpgradeCard({ tool }: { tool: ToolCallData }) {
  const router = useRouter()
  const args = (tool.args ?? {}) as { subdomain?: unknown }
  const subdomain = typeof args.subdomain === "string" && args.subdomain.trim() ? args.subdomain.trim() : null

  return (
    <View className="w-full flex-row items-center gap-3 rounded-2xl border border-border/50 bg-secondary/60 px-3.5 py-3">
      <View className="h-6 w-6 items-center justify-center rounded-full bg-primary/10">
        <Globe size={14} className="text-primary" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-xs font-semibold text-foreground">Publishing needs Pro</Text>
        <Text className="text-[11px] text-muted-foreground">
          {subdomain
            ? `Upgrade to Pro to put this app live at ${subdomain}.shogo.one. Your work is saved; publish again after upgrading.`
            : "Upgrade to Pro to give this app a permanent shogo.one link. Your work is saved; publish again after upgrading."}
        </Text>
      </View>
      <Pressable
        onPress={() => router.push("/(app)/billing" as any)}
        accessibilityRole="button"
        accessibilityLabel="Upgrade to Pro to publish"
        className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 active:bg-primary/80"
      >
        <Text className="text-xs font-medium text-primary-foreground">Upgrade</Text>
      </Pressable>
    </View>
  )
}
