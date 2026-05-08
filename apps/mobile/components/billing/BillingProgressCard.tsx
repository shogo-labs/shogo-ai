// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BillingProgressCard
 *
 * Rounded card with a title, big numerator, progress bar, helper text, and an
 * optional secondary action — used twice on the workspace Usage tab to render
 * "Your included usage" and "On-Demand Usage (Team)".
 */

import type { ReactNode } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Info } from 'lucide-react-native'
import { Card, CardContent, cn } from '@shogo/shared-ui/primitives'

interface BillingProgressCardProps {
  title: string
  /** Big foreground value, e.g. `$20`. */
  current: string
  /** Total / cap, e.g. `$20`. Pass `null` to hide the slash + total. */
  total?: string | null
  /** Progress percent in 0..100. */
  percent: number
  /** Tone of the bar — drives color when usage is healthy vs. running out. */
  tone?: 'primary' | 'warning' | 'destructive'
  /** Optional helper line below the progress bar. */
  helper?: string
  /** Optional second helper line for fine-print. */
  subHelper?: string
  /** Action label rendered to the right (e.g. `Set Limit`). */
  actionLabel?: string
  onActionPress?: () => void
  /** Slot for additional inline content like a tooltip icon next to the title. */
  rightSlot?: ReactNode
}

const BAR_TONE: Record<NonNullable<BillingProgressCardProps['tone']>, string> = {
  primary: 'bg-primary',
  warning: 'bg-amber-500',
  destructive: 'bg-destructive',
}

export function BillingProgressCard({
  title,
  current,
  total,
  percent,
  tone = 'primary',
  helper,
  subHelper,
  actionLabel,
  onActionPress,
  rightSlot,
}: BillingProgressCardProps) {
  const clampedPercent = Math.max(0, Math.min(100, percent))

  return (
    <Card className="flex-1 min-w-[280px]">
      <CardContent className="p-4 gap-3">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-1">
            <Text className="text-xs text-muted-foreground">{title}</Text>
            {rightSlot}
          </View>
        </View>

        <View className="flex-row items-baseline gap-1">
          <Text className="text-2xl font-bold text-foreground">{current}</Text>
          {total != null && (
            <Text className="text-base text-muted-foreground">/ {total}</Text>
          )}
        </View>

        <View className="h-1.5 bg-muted rounded-full overflow-hidden">
          <View
            className={cn('h-full rounded-full', BAR_TONE[tone])}
            style={{ width: `${clampedPercent}%` }}
          />
        </View>

        {(helper || subHelper || actionLabel) && (
          <View className="gap-1">
            {helper && (
              <View className="flex-row items-center gap-1">
                <Text className="text-xs text-muted-foreground flex-1">{helper}</Text>
                {!actionLabel && <Info size={12} className="text-muted-foreground/70" />}
              </View>
            )}
            {subHelper && (
              <Text className="text-[11px] text-muted-foreground">{subHelper}</Text>
            )}
            {actionLabel && onActionPress && (
              <View className="flex-row items-center justify-between gap-2 pt-1">
                <Text className="text-[11px] text-muted-foreground flex-1">
                  {subHelper}
                </Text>
                <Pressable
                  onPress={onActionPress}
                  className="px-3 h-7 items-center justify-center rounded-md border border-border bg-background active:bg-muted"
                >
                  <Text className="text-xs font-medium text-foreground">{actionLabel}</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      </CardContent>
    </Card>
  )
}
