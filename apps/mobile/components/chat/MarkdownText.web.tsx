// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { memo } from "react"
import { Streamdown } from "streamdown"
import "streamdown/styles.css"

export interface MarkdownTextProps {
  children: string
  className?: string
  isStreaming?: boolean
}

const linkSafetyOff = { enabled: false as const }

export const MarkdownText = memo(
  function MarkdownText({ children, className, isStreaming }: MarkdownTextProps) {
    return (
      <Streamdown
        className={className}
        isAnimating={isStreaming}
        linkSafety={linkSafetyOff}
      >
        {children || ""}
      </Streamdown>
    )
  },
  (prev, next) =>
    prev.children === next.children && prev.isStreaming === next.isStreaming
)
