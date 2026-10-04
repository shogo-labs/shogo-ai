// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createContext, useContext, type ReactNode } from "react"
import { View, type StyleProp, type ViewStyle } from "react-native"
import {
  chatColumnStyle,
  type ChatColumnOptions,
} from "../../lib/chat-column"

/**
 * Set by any surface that already applies `chatColumnStyle`. Descendants
 * that can also render standalone (`ChatInput`) read it so they add no
 * width or gutter of their own while inside a column.
 */
const ChatColumnContext = createContext(false)

export function ChatColumnProvider({ children }: { children: ReactNode }) {
  return (
    <ChatColumnContext.Provider value={true}>
      {children}
    </ChatColumnContext.Provider>
  )
}

export function useIsInsideChatColumn(): boolean {
  return useContext(ChatColumnContext)
}

export interface ChatColumnProps extends ChatColumnOptions {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * A `View` that is exactly one chat column wide. Use it for any row that
 * must line up with the transcript and composer (headers, banners, ...).
 */
export function ChatColumn({
  children,
  style,
  testID,
  presentation,
  phone,
  measuredWidth,
}: ChatColumnProps) {
  return (
    <ChatColumnProvider>
      <View
        testID={testID}
        style={[chatColumnStyle({ presentation, phone, measuredWidth }), style]}
      >
        {children}
      </View>
    </ChatColumnProvider>
  )
}
