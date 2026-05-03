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

// Streamdown re-parses the full markdown body on every render. String
// comparison in JS is value-equal, so `prev.children === next.children` does
// already bail out when the rendered text is character-identical between two
// commits. We add an explicit length check first so the common
// "still-streaming, body grew" case fails fast without doing a full character
// compare on long strings, and we explicitly include `className` (the
// previous equality fn ignored it).
function markdownPropsEqual(prev: MarkdownTextProps, next: MarkdownTextProps) {
  if (prev.isStreaming !== next.isStreaming) return false
  if (prev.className !== next.className) return false
  const a = prev.children || ""
  const b = next.children || ""
  return a.length === b.length && a === b
}

export const MarkdownText = memo(
  function MarkdownText({ children, className, isStreaming }: MarkdownTextProps) {
    const cls = className ? `chat-md ${className}` : "chat-md"
    return (
      <Streamdown
        className={cls}
        isAnimating={isStreaming}
        linkSafety={linkSafetyOff}
        controls={false}
      >
        {children || ""}
      </Streamdown>
    )
  },
  markdownPropsEqual,
)
