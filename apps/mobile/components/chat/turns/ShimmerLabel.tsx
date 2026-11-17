// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A short status sentence with a highlight sweeping left → right across its
 * letters.
 *
 * Two rows use it: "Planning next moves" below a streaming turn
 * (`PlanningStatusLine`) and "Rejoining live reply…" under a reply this window
 * has received but not yet attached to (`RejoinRow`, SHO-366). One animation,
 * one timing, so the two lines read as the same kind of status.
 */
import { memo, useEffect, useMemo, useRef } from "react"
import { Animated, Easing, View } from "react-native"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { NATIVE_ACTIVITY_LABEL } from "../NativeActivitySheet"

const TEXT_CLASS = "text-xs text-muted-foreground"
const SHIMMER_TEXT_STYLE = { color: "#a3a3a3", fontSize: 12 } as const
// Phone rows share the 15px activity scale; only the size moves, the dim
// colour stays so the sweep still reads as "not a sentence" (SHO-296).
const NATIVE_SHIMMER_TEXT_STYLE = { color: "#a3a3a3", fontSize: 15 } as const

// Width of the bright band, as a fraction of the label length.
const SHIMMER_BAND = 0.18
const SHIMMER_DIM = 0.25
const SHIMMER_DURATION = 1600
const SHIMMER_PAUSE = 250

function ShimmerLabelImpl({ label }: { label: string }) {
  const nativePhone = useIsNativePhoneLayout()
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: SHIMMER_DURATION,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(SHIMMER_PAUSE),
      ]),
    )
    animation.start()
    return () => {
      animation.stop()
      progress.setValue(0)
    }
  }, [progress])

  const chars = useMemo(() => label.split(""), [label])

  const opacities = useMemo(() => {
    const n = chars.length
    if (n === 0) return []
    const travel = 1 + 2 * SHIMMER_BAND
    // Convert each character's position into the animation progress at which
    // the moving band reaches it. The band starts before the first character
    // and finishes after the last one, producing a complete left-to-right pass.
    return chars.map((_, i) => {
      const pos = n === 1 ? 0.5 : i / (n - 1)
      const peak = (pos + SHIMMER_BAND) / travel
      const halfWidth = SHIMMER_BAND / travel
      return progress.interpolate({
        inputRange: [peak - halfWidth, peak, peak + halfWidth],
        outputRange: [SHIMMER_DIM, 1, SHIMMER_DIM],
        extrapolate: "clamp",
      })
    })
  }, [progress, chars])

  return (
    <View className="flex-row" accessible accessibilityLabel={label}>
      {chars.map((char, i) => (
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

export const ShimmerLabel = memo(ShimmerLabelImpl)

export default ShimmerLabel
