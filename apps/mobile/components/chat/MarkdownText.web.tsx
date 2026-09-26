// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { memo, useMemo, type AnchorHTMLAttributes, type MouseEvent } from "react"
import { useWindowDimensions } from "react-native"
import { Streamdown, defaultUrlTransform } from "streamdown"
import "streamdown/styles.css"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"
import {
  FILE_HREF_PREFIX,
  linkifyBareUrls,
  linkifyFilePaths,
  pathFromFileHref,
} from "./file-links"

export interface MarkdownTextProps {
  children: string
  className?: string
  isStreaming?: boolean
  /** Opens a workspace file when the text mentions its path. */
  onFilePress?: (path: string) => void
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
  if (prev.onFilePress !== next.onFilePress) return false
  const a = prev.children || ""
  const b = next.children || ""
  return a.length === b.length && a === b
}

function FileAwareLink({
  href,
  onFilePress,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  onFilePress?: (path: string) => void
  node?: unknown
}) {
  const path = typeof href === "string" ? pathFromFileHref(href) : null
  if (path && onFilePress) {
    const open = onFilePress
    return (
      <a
        {...rest}
        href={href}
        data-testid="chat-file-link"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault()
          open(path)
        }}
      >
        {children}
      </a>
    )
  }
  return (
    <a {...rest} href={href}>
      {children}
    </a>
  )
}

export const MarkdownText = memo(
  function MarkdownText({ children, className, isStreaming, onFilePress }: MarkdownTextProps) {
    const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
    const { width } = useWindowDimensions()
    const usesMobileChatTypography = usesMobileWorkspaceChrome || width < 640
    const baseClassName = usesMobileChatTypography
      ? "chat-md chat-md-mobile"
      : "chat-md"
    const cls = className ? `${baseClassName} ${className}` : baseClassName
    const source = children || ""
    const fileLinked = onFilePress ? linkifyFilePaths(source) : source
    const body = linkifyBareUrls(fileLinked)
    const components = useMemo(
      () =>
        onFilePress
          ? {
              a: (props: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
                <FileAwareLink {...props} onFilePress={onFilePress} />
              ),
            }
          : undefined,
      [onFilePress],
    )
    return (
      <Streamdown
        className={cls}
        isAnimating={isStreaming}
        linkSafety={linkSafetyOff}
        controls={false}
        components={components}
        urlTransform={(url, key, node) =>
          url.startsWith(FILE_HREF_PREFIX) ? url : defaultUrlTransform(url, key, node)
        }
      >
        {body}
      </Streamdown>
    )
  },
  markdownPropsEqual,
)
