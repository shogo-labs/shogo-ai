// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Rolling usage-window display.
 *
 * Pro and other paid tiers are "unlimited within rolling windows" rather than
 * a depleting monthly USD pool, so usage is surfaced as per-window utilization
 * (`% used`) for the 5-hour and weekly windows. `UsageWindowBar` is the full
 * Billing-page size; `CompactUsageWindows` renders both windows at the smaller
 * density used in the sidebar and project top bar.
 */
import { View, Text } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { UsageWindowView, UsageWindows } from '@shogo/shared-app/hooks'
import { formatResetCountdown } from '../../lib/billing-config'

export function UsageWindowBar({ label, window }: { label: string; window: UsageWindowView | undefined }) {
  // Uncapped (enterprise) plans report a null limit.
  const uncapped = !!window && window.limitUsd == null
  const utilization = window ? Math.min(1, Math.max(0, window.utilization)) : 0
  const pct = Math.round(utilization * 100)
  const countdown = window ? formatResetCountdown(window.resetsAt) : ''

  const usageText = !window
    ? '—'
    : uncapped
      ? 'Unlimited'
      : `${pct}% used`

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-sm text-muted-foreground">{usageText}</Text>
      </View>
      <View className="h-2 rounded-full bg-muted overflow-hidden">
        {!uncapped && (
          <View
            className={cn('h-2 rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${uncapped ? 0 : pct}%` }}
          />
        )}
      </View>
      {!uncapped && countdown ? (
        <Text className="text-xs text-muted-foreground">
          {pct >= 100 ? `Limit reached — resets in ${countdown}` : `Resets in ${countdown}`}
        </Text>
      ) : null}
    </View>
  )
}

function CompactWindowRow({ label, window }: { label: string; window: UsageWindowView | undefined }) {
  const uncapped = !!window && window.limitUsd == null
  const utilization = window ? Math.min(1, Math.max(0, window.utilization)) : 0
  const pct = Math.round(utilization * 100)

  const usageText = !window
    ? '—'
    : uncapped
      ? 'Unlimited'
      : `${pct}% used`

  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">{label}</Text>
        <Text className="text-xs font-medium text-foreground">{usageText}</Text>
      </View>
      <View className="h-1.5 rounded-full bg-muted overflow-hidden">
        {!uncapped && (
          <View
            className={cn('h-full rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${uncapped ? 0 : pct}%` }}
          />
        )}
      </View>
    </View>
  )
}

export function CompactUsageWindows({ windows }: { windows: UsageWindows | undefined }) {
  return (
    <View className="gap-2.5">
      <CompactWindowRow label="5-hour window" window={windows?.fiveHour} />
      <CompactWindowRow label="Weekly window" window={windows?.weekly} />
    </View>
  )
}
