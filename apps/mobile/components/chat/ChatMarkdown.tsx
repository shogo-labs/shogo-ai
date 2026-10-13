// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project chat panel's markdown: the same renderer and the same type
 * scale. Team chat uses this so an agent's reply looks the same in a channel
 * or DM as it does in the session that wrote it.
 */
import type { ReactElement } from "react"
import { Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"

export interface ChatMarkdownProps {
  children: string
  isStreaming?: boolean
  /** Opens a workspace file when the text mentions its path. */
  onFilePress?: (path: string) => void
  /** Return true to handle a link in the app instead of opening it in a browser. */
  onLinkPress?: (href: string) => boolean
  /** Extra classes. A color class such as `text-white` overrides the default. */
  className?: string
}

// Metro inlines `Platform.OS` and drops the other branch, so a web bundle
// never loads react-native-marked and a native bundle never loads Streamdown.
// These tests run as web, so they take the Streamdown path too.
const MarkdownText: (props: ChatMarkdownProps) => ReactElement =
  Platform.OS === "web"
    ? require("./MarkdownText.web").MarkdownText
    : require("./MarkdownText").MarkdownText

export function ChatMarkdown({
  children,
  isStreaming,
  onFilePress,
  onLinkPress,
  className,
}: ChatMarkdownProps) {
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
  return (
    <MarkdownText
      className={cn(
        Platform.OS !== "web" || usesMobileWorkspaceChrome
          ? "text-foreground text-base leading-6"
          : "text-foreground text-xs prose-sm",
        className,
      )}
      isStreaming={isStreaming}
      onFilePress={onFilePress}
      onLinkPress={onLinkPress}
    >
      {children}
    </MarkdownText>
  )
}
