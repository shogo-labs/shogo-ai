// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DateRangePills
 *
 * Period selector for the workspace Usage tab. Renders a label like
 * `May 02 - May 08` next to a row of pills `1d / 7d / 30d / MTD / Last month`.
 *
 * Mirrors the resolved window logic in
 * `apps/api/src/services/analytics.service.ts:periodToWindow` so the label
 * stays in sync with what the server queries.
 */

import { Platform } from 'react-native'
import { View, Text, Pressable } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { AnalyticsPeriod } from './SharedAnalytics'

const PILLS: { id: AnalyticsPeriod; label: string }[] = [
  { id: '1d', label: '1d' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'mtd', label: 'MTD' },
  { id: 'last_month', label: 'Last month' },
]

const periodActiveNativeShadow = Platform.select({
  ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 1 },
  android: { elevation: 1 },
  default: undefined,
})

function periodWindow(period: AnalyticsPeriod): { from: Date; to: Date } {
  const now = new Date()
  switch (period) {
    case '1d':
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now }
    case '30d':
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: now }
    case '90d':
      return { from: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), to: now }
    case '1y':
      return { from: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), to: now }
    case 'mtd':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: start, to: end }
    }
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
}

export function formatRangeLabel(period: AnalyticsPeriod): string {
  const { from, to } = periodWindow(period)
  return `${formatDate(from)} - ${formatDate(to)}`
}

export function DateRangePills({
  value,
  onChange,
  className,
}: {
  value: AnalyticsPeriod
  onChange: (p: AnalyticsPeriod) => void
  className?: string
}) {
  return (
    <View className={cn('flex-row items-center gap-3 flex-wrap', className)}>
      <View className="flex-row items-center gap-1.5 px-3 h-9 border border-border rounded-md">
        <Text className="text-sm text-foreground">{formatRangeLabel(value)}</Text>
        <ChevronDown size={14} className="text-muted-foreground" />
      </View>
      <View className="flex-row items-center bg-muted rounded-md p-0.5 gap-0.5">
        {PILLS.map((p) => {
          const isActive = value === p.id
          return (
            <Pressable
              key={p.id}
              onPress={() => onChange(p.id)}
              className={cn(
                'px-3 h-8 items-center justify-center rounded',
                isActive ? 'bg-background' : '',
              )}
              style={isActive ? periodActiveNativeShadow : undefined}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  isActive ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {p.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}
