// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Monospace tool output (args, results, errors) that the user can copy.
 *
 * Android 11's TextView drags an existing selection on long-press using a
 * thumbnail of the selected text. A selection of only line breaks, common in
 * pretty-printed JSON, measures 0 px wide and the framework throws "Drag
 * shadow dimensions must be positive", crashing the app (Sentry
 * SHOGO-ANDROID-Z). On Android the block is therefore not natively
 * selectable; a long-press copies the whole block instead.
 */
import * as Clipboard from "expo-clipboard"
import { Platform, Text, type TextProps } from "react-native"

export interface CodeTextProps extends Omit<TextProps, "children" | "selectable"> {
  children: string
}

export function CodeText({ children, ...props }: CodeTextProps) {
  if (Platform.OS !== "android") {
    return (
      <Text {...props} selectable>
        {children}
      </Text>
    )
  }
  return (
    <Text
      {...props}
      accessibilityHint="Long-press to copy"
      onLongPress={() => {
        void Clipboard.setStringAsync(children).catch(() => {})
      }}
    >
      {children}
    </Text>
  )
}
