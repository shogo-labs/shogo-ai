// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { memo, useMemo, type AnchorHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useWindowDimensions } from "react-native"
import { Streamdown, defaultUrlTransform } from "streamdown"
import "streamdown/styles.css"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"
import { usePhoneLayoutOverride } from "../../lib/native-phone-layout"
import { normalizeRichTextPaste } from "../../lib/rich-text-paste"
import {
  FILE_HREF_PREFIX,
  IMAGE_SRC_PREFIX,
  isMentionHref,
  linkifyBareUrls,
  linkifyFilePaths,
  mentionTargetFromHref,
  pathFromFileHref,
  rewriteWorkspaceMedia,
  resolveRelativeLinks,
  type MentionTarget,
} from "./file-links"
import { MarkdownMedia } from "./MarkdownMedia.web"
import { FileTypeIcon } from "./FileTypeIcon.web"
import { useShareFileOpener } from "./share-file-context"
import { parseInAppFileHref } from "../../lib/share-file-links"
import { withHardBreaks } from "../../lib/markdown-breaks"
import type { MarkdownVariant } from "./MarkdownText"

export interface MarkdownTextProps {
  children: string
  className?: string
  /**
   * `false` renders the text as finished markdown (one parse, no
   * incomplete-markdown repair). Leave unset for text that may still grow.
   */
  isStreaming?: boolean
  /**
   * Type scale. `card` pins the compact 12/18 body copy a tool card needs
   * regardless of the outer window width; the palette is unchanged.
   */
  variant?: MarkdownVariant
  /** Opens a workspace file when the text mentions its path. */
  onFilePress?: (path: string) => void
  /** Mentioned paths that pass this check render as file chips. */
  fileExists?: (path: string) => boolean
  /** Return true to handle a link in the app instead of navigating to it. */
  onLinkPress?: (href: string) => boolean
  /** Opens a person's or agent's profile when their @-mention is tapped. */
  onMentionPress?: (target: MentionTarget) => void
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
  if (prev.variant !== next.variant) return false
  if (prev.className !== next.className) return false
  if (prev.onFilePress !== next.onFilePress) return false
  if (prev.fileExists !== next.fileExists) return false
  if (prev.onLinkPress !== next.onLinkPress) return false
  if (prev.onMentionPress !== next.onMentionPress) return false
  const a = prev.children || ""
  const b = next.children || ""
  return a.length === b.length && a === b
}

function FileAwareLink({
  href,
  onFilePress,
  fileExists,
  onLinkPress,
  children,
  node: _node,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  onFilePress?: (path: string) => void
  fileExists?: (path: string) => boolean
  onLinkPress?: (href: string) => boolean
  node?: unknown
}) {
  const openShareFile = useShareFileOpener()
  // A link to a file the app serves is a chip, never an <a href> that leaves
  // the app: clicking it opens the file in the side pane (or the modal).
  const servedFile = typeof href === "string" ? parseInAppFileHref(href) : null
  if (servedFile && openShareFile) {
    const open = openShareFile
    return (
      <a
        href={href}
        title={servedFile.name}
        className="chat-file-chip"
        data-testid="chat-file-chip"
        data-file-kind={servedFile.kind}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault()
          open(servedFile)
        }}
      >
        <FileTypeIcon path={servedFile.name} size={14} />
        <span>{servedFile.name}</span>
      </a>
    )
  }
  const path = typeof href === "string" ? pathFromFileHref(href) : null
  if (path && onFilePress && fileExists?.(path)) {
    const open = onFilePress
    return (
      <a
        href={href}
        title={path}
        className="chat-file-chip"
        data-testid="chat-file-chip"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault()
          open(path)
        }}
      >
        <FileTypeIcon path={path} size={14} />
        <span>{path.split("/").pop() || path}</span>
      </a>
    )
  }
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
  // Everything else the host wants to keep in the app — a link to a message,
  // for one. The href stays on the anchor so copying or a middle-click still
  // works; only a plain click is taken over.
  if (onLinkPress && typeof href === "string") {
    const handle = onLinkPress
    return (
      <a
        {...rest}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (handle(href)) event.preventDefault()
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

function MentionHighlight({
  children,
  target,
  onPress,
}: {
  children?: ReactNode
  target?: MentionTarget | null
  onPress?: (target: MentionTarget) => void
}) {
  const pressableTarget = target && onPress ? target : null
  const open = onPress
  return (
    <span
      data-testid="chat-mention"
      className="rounded bg-yellow-200 px-0.5 font-semibold text-yellow-950 dark:bg-yellow-400/30 dark:text-yellow-100"
      role={pressableTarget ? "button" : undefined}
      tabIndex={pressableTarget ? 0 : undefined}
      onClick={pressableTarget ? () => open!(pressableTarget) : undefined}
      onKeyDown={
        pressableTarget
          ? (event: KeyboardEvent<HTMLSpanElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              open!(pressableTarget)
            }
          : undefined
      }
    >
      {children}
    </span>
  )
}

export const MarkdownText = memo(
  function MarkdownText({
    children,
    className,
    isStreaming,
    variant = "default",
    onFilePress,
    fileExists,
    onLinkPress,
    onMentionPress,
  }: MarkdownTextProps) {
    const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
    const phoneLayoutOverride = usePhoneLayoutOverride()
    const { width } = useWindowDimensions()
    const usesCompactChatTypography = phoneLayoutOverride === false
    const usesMobileChatTypography =
      usesMobileWorkspaceChrome || (phoneLayoutOverride === null && width < 640)
    // A tool card's body is card-sized wherever it renders; the 16px mobile
    // chat scale would blow a three-line card open on a phone-width window.
    const baseClassName =
      variant === "card" || usesCompactChatTypography
        ? "chat-md chat-md-compact"
        : usesMobileChatTypography
        ? "chat-md chat-md-mobile"
        : "chat-md"
    const cls = className ? `${baseClassName} ${className}` : baseClassName
    const source = children || ""
    const body = useMemo(() => {
      const normalized = withHardBreaks(rewriteWorkspaceMedia(normalizeRichTextPaste(source)))
      // A relative link we wrote cannot be opened by a browser: Streamdown's
      // hardener replaces it with `[blocked]`. Resolve it before it parses.
      const resolved = resolveRelativeLinks(normalized, { fileLinks: !!onFilePress })
      const fileLinked = onFilePress ? linkifyFilePaths(resolved) : resolved
      return linkifyBareUrls(fileLinked)
    }, [onFilePress, source])
    const components = useMemo(
      () => ({
        a: (props: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) =>
          isMentionHref(props.href) ? (
            <MentionHighlight
              target={mentionTargetFromHref(props.href)}
              onPress={onMentionPress}
            >
              {props.children}
            </MentionHighlight>
          ) : (
            <FileAwareLink {...props} onFilePress={onFilePress} fileExists={fileExists} onLinkPress={onLinkPress} />
          ),
        img: ({ src, alt }: { src?: string | Blob; alt?: string; node?: unknown }) => (
          <MarkdownMedia src={typeof src === "string" ? src : null} alt={alt} />
        ),
      }),
      [onFilePress, fileExists, onLinkPress, onMentionPress],
    )
    return (
      <Streamdown
        className={cls}
        mode={isStreaming === false ? "static" : "streaming"}
        isAnimating={isStreaming}
        linkSafety={linkSafetyOff}
        controls={false}
        components={components}
        urlTransform={(url, key, node) =>
          url.startsWith(FILE_HREF_PREFIX) || url.startsWith(IMAGE_SRC_PREFIX) || isMentionHref(url)
            ? url
            : defaultUrlTransform(url, key, node)
        }
      >
        {body}
      </Streamdown>
    )
  },
  markdownPropsEqual,
)
