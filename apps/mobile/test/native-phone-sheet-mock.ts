// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "./react-native-mock"

export function pressableAsButton({
  accessibilityLabel,
  accessibilityRole,
  children,
  onPress,
  ...props
}: {
  accessibilityLabel?: string
  accessibilityRole?: string
  children?: ReactNode
  onPress?: () => void
  [key: string]: unknown
}) {
  return createElement(
    "button",
    {
      ...props,
      "aria-label": accessibilityLabel,
      onClick: onPress,
      role: accessibilityRole,
    },
    children,
  )
}

export function createNativePhoneReactNativeMock() {
  return createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: pressableAsButton,
  })
}

export function createNativePhoneSheetMock() {
  return {
    NativePhoneSheetCloseButton: ({ onPress }: { onPress: () => void }) =>
      createElement("button", { "aria-label": "Close", onClick: onPress }, "Close"),
    NativePhoneSheet: ({
      visible,
      title,
      headerLeft,
      children,
      footer,
      testID,
    }: {
      visible: boolean
      title?: string
      headerLeft?: ReactNode
      children: ReactNode
      footer?: ReactNode
      testID?: string
    }) =>
      visible
        ? createElement(
            "div",
            { "data-testid": testID },
            headerLeft,
            createElement("h1", null, title),
            children,
            footer,
          )
        : null,
  }
}
