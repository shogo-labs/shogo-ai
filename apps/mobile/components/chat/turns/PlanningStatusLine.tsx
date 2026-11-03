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
 * A highlight sweeps left → right across the letters.
 */

import { memo, useEffect, useMemo, useRef } from "react"
import { Animated, Easing, View } from "react-native"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import {
  NATIVE_ACTIVITY_LABEL,
  NATIVE_ACTIVITY_ROW,
} from "../NativeActivitySheet"

const LABEL = "Planning next moves"
const TEXT_CLASS = "text-xs text-muted-foreground"
const SHIMMER_TEXT_STYLE = { color: "#a3a3a3", fontSize: 12 } as const
// Phone rows share the 15px activity scale; only the size moves, the dim
// colour stays so the sweep still reads as "not a sentence" (SHO-296).
const NATIVE_SHIMMER_TEXT_STYLE = { color: "#a3a3a3", fontSize: 15 } as const

const SHIMMER_CHARS = LABEL.split("")
// Width of the bright band, as a fraction of the label length.
const SHIMMER_BAND = 0.18
const SHIMMER_DIM = 0.25

function ShimmerLabel({ nativePhone }: { nativePhone: boolean }) {
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(250),
      ]),
    )
    animation.start()
    return () => {
      animation.stop()
      progress.setValue(0)
    }
  }, [progress])

  const opacities = useMemo(() => {
    const n = SHIMMER_CHARS.length
    const travel = 1 + 2 * SHIMMER_BAND
    // Convert each character's position into the animation progress at which
    // the moving band reaches it. The band starts before the first character
    // and finishes after the last one, producing a complete left-to-right pass.
    return SHIMMER_CHARS.map((_, i) => {
      const pos = i / (n - 1)
      const peak = (pos + SHIMMER_BAND) / travel
      const halfWidth = SHIMMER_BAND / travel
      return progress.interpolate({
        inputRange: [peak - halfWidth, peak, peak + halfWidth],
        outputRange: [SHIMMER_DIM, 1, SHIMMER_DIM],
        extrapolate: "clamp",
      })
    })
  }, [progress])

  return (
    <View className="flex-row" accessible accessibilityLabel={LABEL}>
      {SHIMMER_CHARS.map((char, i) => (
        <Animated.Text
          key={i}
          className={nativePhone ? NATIVE_ACTIVITY_LABEL : TEXT_CLASS}
          style={[nativePhone ? NATIVE_SHIMMER_TEXT_STYLE : SHIMMER_TEXT_STYLE, { opacity: opacities[i] }]}
        >
          {char === " " ? "\u00A0" : char}
        </Animated.Text>
      ))}
    </View>
  )
}

function PlanningStatusLineImpl() {
  const nativePhone = useIsNativePhoneLayout()
  return (
    <View className={nativePhone ? NATIVE_ACTIVITY_ROW : "pt-1 pb-2"}>
      <ShimmerLabel nativePhone={nativePhone} />
    </View>
  )
}

export const PlanningStatusLine = memo(PlanningStatusLineImpl)

export default PlanningStatusLine
