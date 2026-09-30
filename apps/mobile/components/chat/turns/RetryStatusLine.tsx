// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inline retry status, rendered in place of `PlanningStatusLine` while a
 * turn is being retried (see `turnRetryStatus.ts` for the staging). The
 * clock ticks inside this component so ChatPanel doesn't re-render per second.
 */

import { memo, useEffect, useState } from "react"
import { Pressable, Text, View } from "react-native"
import { ShimmerLabel } from "./PlanningStatusLine"
import { describeRetryStatus, type TurnRetryStatus } from "./turnRetryStatus"

export interface RetryStatusLineProps {
  status: TurnRetryStatus
  onRetryNow: () => void
  switchModel: { label: string; onSwitch: () => void } | null
}

export function useRetryClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function RetryStatusLineImpl({ status, onRetryNow, switchModel }: RetryStatusLineProps) {
  const now = useRetryClock(true)
  const view = describeRetryStatus(status, now)
  return (
    <View className="pt-1 pb-2 gap-y-1" accessibilityLiveRegion="polite">
      <View className="flex-row flex-wrap items-center gap-x-1">
        <ShimmerLabel label={view.headline} />
        {view.trailing ? (
          <Text className="text-xs text-muted-foreground">{view.trailing}</Text>
        ) : null}
        {view.showRetryNow ? (
          <Pressable
            onPress={onRetryNow}
            accessibilityRole="button"
            accessibilityLabel="Retry now"
            hitSlop={8}
          >
            <Text className="text-xs font-medium text-primary">{"\u00B7 Retry now"}</Text>
          </Pressable>
        ) : null}
      </View>
      {view.detail ? <Text className="text-xs text-muted-foreground">{view.detail}</Text> : null}
      {view.suggestSwitchModel && switchModel ? (
        <Pressable
          onPress={switchModel.onSwitch}
          accessibilityRole="button"
          accessibilityLabel={`Switch to ${switchModel.label}`}
          className="self-start rounded-md border border-border px-2 py-1"
        >
          <Text className="text-xs font-medium text-foreground">{`Switch to ${switchModel.label}`}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export const RetryStatusLine = memo(RetryStatusLineImpl)

export default RetryStatusLine
