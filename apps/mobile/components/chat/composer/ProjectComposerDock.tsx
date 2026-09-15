// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from "react"
import { Animated, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { chatComposerDockStyle } from "../../../lib/native-composer-keyboard"

/**
 * Project chat composer column.
 *
 * Keyboard pad is an Animated.Value, so the padded shell must be
 * Animated.View. NativeWind className on that node never applied (web
 * input went full-bleed); keep alignment classes on the regular Views.
 */
export function ProjectComposerDock({
  columnWidth,
  keyboardPad,
  keyboardOpen,
  restPad,
  applyKeyboardPad,
  native,
  children,
}: {
  columnWidth?: number
  keyboardPad: Animated.Value
  keyboardOpen: boolean
  restPad: number
  applyKeyboardPad: boolean
  native: boolean
  children: ReactNode
}) {
  return (
    <View className="w-full items-center">
      <Animated.View
        testID="project-composer-dock"
        style={chatComposerDockStyle({
          measuredWidth: columnWidth,
          // Only use the measured keyboard overlap while the keyboard is
          // actually visible. A stale keyboard frame must never leave the
          // composer floating in the middle of the chat after dismissal.
          keyboardPad: applyKeyboardPad ? (keyboardOpen ? keyboardPad : restPad) : undefined,
          webOverflowVisible: applyKeyboardPad && !native,
        })}
      >
        <View className={cn("bg-transparent w-full mt-1", !native && "relative")}>
          {children}
        </View>
      </Animated.View>
    </View>
  )
}
