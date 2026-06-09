// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared helpers for the admin analytics pages.
 *
 * The analytics surface is split into two sibling pages — Marketing
 * (analytics.tsx) and AI / engineering (ai-analytics.tsx). Both share the same
 * data-fetch helper and the page header (title + period selector + internal
 * toggle), extracted here to avoid duplication. Files prefixed with `_` are
 * ignored by expo-router, so this is not registered as a route.
 */

import { View, Text, Switch } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'
import { type AnalyticsPeriod, PeriodSelector } from '../../components/analytics/SharedAnalytics'

export const API_BASE = `${API_URL}/api/admin`

/** Fetch an admin analytics endpoint, returning `json.data` or null on error. */
export async function fetchAdminJson<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T | null> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  try {
    const res = await fetch(`${API_BASE}${path}${qs}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

/** Shared page header: title + subtitle, period selector, and internal toggle. */
export function AnalyticsHeader({
  title,
  subtitle,
  isWide,
  period,
  onPeriodChange,
  excludeInternal,
  onExcludeInternalChange,
}: {
  title: string
  subtitle: string
  isWide: boolean
  period: AnalyticsPeriod
  onPeriodChange: (p: AnalyticsPeriod) => void
  excludeInternal: boolean
  onExcludeInternalChange: (v: boolean) => void
}) {
  return (
    <>
      <View className="flex-row items-center justify-between mb-4">
        <View>
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-lg')}>
            {title}
          </Text>
          <Text className="text-xs text-muted-foreground">{subtitle}</Text>
        </View>
      </View>

      <View className="flex-row items-center justify-between mb-4">
        <PeriodSelector value={period} onChange={onPeriodChange} />
        <View className="flex-row items-center gap-2">
          <Text className="text-[10px] text-muted-foreground">Exclude internal</Text>
          <Switch
            value={excludeInternal}
            onValueChange={onExcludeInternalChange}
            trackColor={{ false: '#767577', true: '#6366f1' }}
          />
        </View>
      </View>
    </>
  )
}
