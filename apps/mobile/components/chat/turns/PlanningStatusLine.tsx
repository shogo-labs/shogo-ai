// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanningStatusLine Component (React Native)
 *
 * Muted, animated status line rendered at the bottom of a
 * streaming turn whenever the model is "between" visible activity —
 * no tool actively running, no prose currently growing. Covers both
 * the gap between a finished tool call and the next one, and a live
 * reasoning burst (which renders as this line instead of a live
 * `ThinkingWidget` — see `shouldShowPlanningStatus` in
 * `turnShaping.ts`).
 *
 * A highlight sweeps left → right across the letters (`ShimmerLabel`).
 */

import { memo } from "react"
import { View } from "react-native"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { NATIVE_ACTIVITY_ROW } from "../NativeActivitySheet"
import { ShimmerLabel } from "./ShimmerLabel"

const LABEL = "Planning next moves"

function PlanningStatusLineImpl() {
  const nativePhone = useIsNativePhoneLayout()
  return (
    <View className={nativePhone ? NATIVE_ACTIVITY_ROW : "pt-1 pb-2"}>
      <ShimmerLabel label={LABEL} />
    </View>
  )
}

export const PlanningStatusLine = memo(PlanningStatusLineImpl)

export default PlanningStatusLine
