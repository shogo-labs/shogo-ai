import React, { memo } from "react"
import { Streamdown } from "streamdown"
import "streamdown/styles.css"

export interface MarkdownTextProps {
  children: string
  className?: string
  isStreaming?: boolean
}

export const MarkdownText = memo(
  function MarkdownText({ children, className, isStreaming }: MarkdownTextProps) {
    return (
      <Streamdown
        className={className}
        isAnimating={isStreaming}
      >
        {children || ""}
      </Streamdown>
    )
  },
  (prev, next) =>
    prev.children === next.children && prev.isStreaming === next.isStreaming
)
