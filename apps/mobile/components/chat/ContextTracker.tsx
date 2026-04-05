// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform, Pressable } from "react-native"
import { useColorScheme } from "nativewind"
import Svg, { Circle } from "react-native-svg"
import {
  Tooltip,
  TooltipContent,
  TooltipText,
} from "@/components/ui/tooltip"

export interface ContextTrackerProps {
  inputTokens: number
  contextWindowTokens: number
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`
  }
  return String(tokens)
}

const SIZE = 16
const STROKE_WIDTH = 2.5
const RADIUS = (SIZE - STROKE_WIDTH) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function getFillColor(pct: number): string {
  if (pct >= 90) return "#ef4444"
  if (pct >= 70) return "#f59e0b"
  return "#a1a1aa"
}

export function ContextTracker({ inputTokens, contextWindowTokens }: ContextTrackerProps) {
  const { colorScheme } = useColorScheme()
  const percentage = Math.min((inputTokens / contextWindowTokens) * 100, 100)
  const strokeDashoffset = CIRCUMFERENCE - (percentage / 100) * CIRCUMFERENCE
  const fillColor = getFillColor(percentage)
  const trackColor = colorScheme === "dark" ? "#3f3f46" : "#d4d4d8"
  const label = `${percentage.toFixed(1)}% · ${formatTokenCount(inputTokens)} / ${formatTokenCount(contextWindowTokens)} context used`

  const ring = (
    <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <Circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        stroke={trackColor}
        strokeWidth={STROKE_WIDTH}
        fill="none"
      />
      <Circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        stroke={fillColor}
        strokeWidth={STROKE_WIDTH}
        fill="none"
        strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        rotation={-90}
        origin={`${SIZE / 2}, ${SIZE / 2}`}
      />
    </Svg>
  )

  if (Platform.OS !== "web") {
    return ring
  }

  return (
    <Tooltip
      placement="top"
      trigger={(triggerProps) => (
        <Pressable {...triggerProps}>{ring}</Pressable>
      )}
    >
      <TooltipContent className="py-0.5 px-2 rounded bg-popover border border-border shadow-sm">
        <TooltipText className="text-[10px] text-popover-foreground">{label}</TooltipText>
      </TooltipContent>
    </Tooltip>
  )
}
