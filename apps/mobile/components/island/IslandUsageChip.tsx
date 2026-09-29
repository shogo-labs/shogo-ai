// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect } from "react"
import { Pressable, Text, View } from "react-native"
import { Gauge } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useBillingData } from "@shogo/shared-app/hooks"
import { CompactUsageWindows } from "../billing/UsageWindows"
import { getWindowDisplays, type UsageOverageContext } from "../../lib/billing-config"

const USAGE_POLL_MS = 60_000
const WARN_PCT = 80

export interface IslandUsage {
  windows: ReturnType<typeof useBillingData>["usageWindows"]
  overage?: UsageOverageContext
  pct: number
  uncapped: boolean
  tone: "ok" | "warn" | "limit"
  hasAdvancedModelAccess: boolean
  empty: boolean
}

export function useIslandUsage(workspaceId: string | undefined, active: boolean): IslandUsage {
  const billing = useBillingData(workspaceId)
  const { refetchUsageWallet, refetchSubscription } = billing

  useEffect(() => {
    if (!active || !workspaceId) return
    refetchUsageWallet()
    const timer = setInterval(() => {
      refetchUsageWallet()
      refetchSubscription()
    }, USAGE_POLL_MS)
    return () => clearInterval(timer)
  }, [active, workspaceId, refetchUsageWallet, refetchSubscription])

  const { fiveHour, weekly } = getWindowDisplays(billing.usageWindows)
  const pct = Math.max(fiveHour.pct, weekly.pct)
  const balance = billing.effectiveBalance
  return {
    windows: billing.usageWindows,
    overage: balance
      ? {
          enabled: balance.overageEnabled,
          active: balance.overageActive,
          accumulatedUsd: balance.overageAccumulatedUsd,
        }
      : undefined,
    pct,
    uncapped: fiveHour.uncapped && weekly.uncapped,
    tone: fiveHour.atLimit || weekly.atLimit ? "limit" : pct >= WARN_PCT ? "warn" : "ok",
    hasAdvancedModelAccess: billing.hasAdvancedModelAccess,
    empty: fiveHour.empty && weekly.empty,
  }
}

const TONE_COLOR = { ok: "#a1a1aa", warn: "#fcd34d", limit: "#fda4af" } as const

export function IslandUsageChip({ usage, onPress }: { usage: IslandUsage; onPress: () => void }) {
  if (usage.empty) return null
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={usage.uncapped ? "Usage" : `Usage ${usage.pct}%`}
      className={cn(
        "flex-row items-center gap-1 rounded-full px-2 py-0.5",
        usage.tone === "limit" ? "bg-rose-500/20" : usage.tone === "warn" ? "bg-amber-400/15" : "bg-white/10",
      )}
    >
      <Gauge size={11} color={TONE_COLOR[usage.tone]} />
      <Text className="text-[10px] font-semibold" style={{ color: TONE_COLOR[usage.tone] }}>
        {usage.uncapped ? "Usage" : `${usage.pct}%`}
      </Text>
    </Pressable>
  )
}

export function IslandUsagePanel({ usage, onOpenBilling }: { usage: IslandUsage; onOpenBilling: () => void }) {
  return (
    <View className="gap-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <CompactUsageWindows windows={usage.windows} overage={usage.overage} />
      <Pressable onPress={onOpenBilling} className="self-end">
        <Text className="text-[11px] font-semibold text-primary">Manage usage</Text>
      </Pressable>
    </View>
  )
}
