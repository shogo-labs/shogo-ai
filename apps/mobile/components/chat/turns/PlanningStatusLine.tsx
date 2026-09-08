// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanningStatusLine Component (React Native)
 *
 * Muted, gently pulsing status line rendered at the bottom of a
 * streaming turn whenever the model is "between" visible activity —
 * no tool actively running, no prose currently growing. Covers both
 * the gap between a finished tool call and the next one, and a live
 * reasoning burst (which renders as this line instead of a live
 * `ThinkingWidget` — see `shouldShowPlanningStatus` in
 * `turnShaping.ts`).
 */

import { memo } from "react"
import { Text } from "react-native"
import { Motion } from "@legendapp/motion"

const PULSE_ANIMATE = { opacity: 1 }
const PULSE_INITIAL = { opacity: 0.4 }
const PULSE_TRANSITION = {
  type: "timing",
  duration: 900,
  easing: "easeInOut",
  repeat: Infinity,
  repeatReverse: true,
} as const

function PlanningStatusLineImpl() {
  return (
    <Motion.View initial={PULSE_INITIAL} animate={PULSE_ANIMATE} transition={PULSE_TRANSITION}>
      <Text className="text-[11px] text-muted-foreground">Planning next moves</Text>
    </Motion.View>
  )
}

export const PlanningStatusLine = memo(PlanningStatusLineImpl)

export default PlanningStatusLine
