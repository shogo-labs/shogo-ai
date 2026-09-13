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
import { useState } from 'react'
import { View, Text } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { UsageWindowView, UsageWindows } from '@shogo/shared-app/hooks'
import {
  formatResetCountdown,
  formatUsd,
  getWindowDisplays,
  getUsageLimitNotice,
  usageFillPixelWidth,
  type UsageOverageContext,
  type WindowDisplay,
} from '../../lib/billing-config'
import { isNativePlatform, nativePhoneFillStyle } from '../../lib/native-phone-layout'
import { densityFor } from '../../lib/phone-density'

/** NativeWind `h-2` / `h-1.5` on the billing and compact meters. */
const USAGE_TRACK_HEIGHT = 8
const COMPACT_USAGE_TRACK_HEIGHT = 6

function usageLabel(display: Pick<WindowDisplay, 'empty' | 'uncapped' | 'pct' | 'usedUsd'>): string {
  if (display.empty) return '—'
  if (display.uncapped) {
    return display.usedUsd > 0 ? `${formatUsd(display.usedUsd)} used` : 'Unlimited'
  }
  return `${display.pct}% used`
}

function UsageMeterTrack({
  pct,
  height,
}: {
  pct: number
  height: number
}) {
  // Yoga treats percentage `width` as 0 inside overflow-hidden native cards.
  // Web/desktop keep `%` so the bar does not wait on an onLayout pass.
  const native = isNativePlatform()
  const [trackW, setTrackW] = useState(0)
  const fillW = usageFillPixelWidth(trackW, pct)
  const fillClass = cn('rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-primary')

  return (
    <View
      className="overflow-hidden rounded-full bg-muted"
      style={{
        height,
        ...(native ? { position: 'relative' as const, alignSelf: 'stretch' as const } : null),
      }}
      onLayout={
        native
          ? (e) => {
              const next = e.nativeEvent.layout.width
              if (next !== trackW) setTrackW(next)
            }
          : undefined
      }
    >
      {native ? (
        fillW > 0 ? (
          <View className={fillClass} style={nativePhoneFillStyle(fillW)} />
        ) : null
      ) : pct > 0 ? (
        <View className={fillClass} style={{ width: `${pct}%`, height }} />
      ) : null}
    </View>
  )
}

export function UsageWindowBar({
  label,
  window,
  coupledFull = false,
}: {
  label: string
  window: UsageWindowView | undefined
  /** Force the bar to display 100% (e.g. 5-hour when weekly is exhausted). */
  coupledFull?: boolean
}) {
  // Uncapped (enterprise) plans report a null limit.
  const uncapped = !!window && window.limitUsd == null
  const utilization = window ? Math.min(1, Math.max(0, window.utilization)) : 0
  const pct = coupledFull && !uncapped ? 100 : Math.round(utilization * 100)
  const countdown = window ? formatResetCountdown(window.resetsAt) : ''
  const usageText = usageLabel({
    empty: !window,
    uncapped,
    pct,
    usedUsd: window?.usedUsd ?? 0,
  })

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-sm text-muted-foreground">{usageText}</Text>
      </View>
      <UsageMeterTrack pct={uncapped ? 0 : pct} height={USAGE_TRACK_HEIGHT} />
      {!uncapped && countdown ? (
        <Text className="text-xs text-muted-foreground">
          {pct >= 100 ? `Limit reached — resets in ${countdown}` : `Resets in ${countdown}`}
        </Text>
      ) : null}
    </View>
  )
}

function CompactWindowRow({
  label,
  display,
  comfortable = false,
}: {
  label: string
  display: WindowDisplay
  comfortable?: boolean
}) {
  const density = densityFor(comfortable)
  return (
    <View className={comfortable ? 'gap-1.5' : 'gap-1'}>
      <View className="flex-row items-center justify-between">
        <Text className={cn(density.text.label, 'text-muted-foreground')}>{label}</Text>
        <Text className={cn(density.text.label, 'font-medium text-foreground')}>
          {usageLabel(display)}
        </Text>
      </View>
      <UsageMeterTrack
        pct={display.uncapped ? 0 : display.pct}
        height={comfortable ? USAGE_TRACK_HEIGHT : COMPACT_USAGE_TRACK_HEIGHT}
      />
    </View>
  )
}

export function CompactUsageWindows({
  windows,
  overage,
  comfortable = false,
}: {
  windows: UsageWindows | undefined
  overage?: UsageOverageContext
  /** Slightly larger labels for the native account sheet. */
  comfortable?: boolean
}) {
  const { fiveHour, weekly } = getWindowDisplays(windows)
  const density = densityFor(comfortable)
  const atLimit = fiveHour.atLimit || weekly.atLimit
  // Resume time is the binding constraint: when weekly is exhausted you stay
  // blocked until it resets (resetting the 5-hour window won't help).
  const countdown = weekly.atLimit ? weekly.countdown : fiveHour.countdown
  const notice = getUsageLimitNotice({ atLimit, overage, countdown })

  return (
    <View className={comfortable ? 'gap-3' : 'gap-2.5'}>
      <CompactWindowRow label="5-hour window" display={fiveHour} comfortable={comfortable} />
      <CompactWindowRow label="Weekly window" display={weekly} comfortable={comfortable} />
      {notice ? (
        <Text
          className={cn(
            density.text.label,
            notice.tone === 'overage' || notice.tone === 'expired' ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {notice.text}
        </Text>
      ) : null}
    </View>
  )
}
