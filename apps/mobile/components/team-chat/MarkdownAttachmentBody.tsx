// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pasted markdown block, rendered as markdown in the channel.
 *
 * A paste of a couple of thousand characters becomes a file attachment
 * (`Pasted markdown.md`, from `pastedEntryToAttachment`), and that file is the
 * one document people paste *in order to read it*. It therefore renders through
 * `ChatMarkdown` — the same renderer a message body uses — instead of the six
 * flattened plain-text lines an attachment card shows.
 *
 * Two things make that work:
 *
 * - The body is read with `fileText(id, { raw: true })`. The stored
 *   `extractedText` is tidied for search (runs of whitespace collapsed, blank
 *   lines dropped), which glues paragraphs together and destroys fenced-code
 *   indentation; the raw read decodes the stored bytes.
 * - The card keeps the file header (name, type, size, download), so a reader
 *   still knows what they are looking at and can still take the file away.
 *
 * Long pastes clamp to about 25 rendered lines with a fade and one **Show
 * more** that expands in place, paging the rest of the body up to the reading
 * route's 60k cap. A body that cannot be read (a failed fetch, `text: null`)
 * falls back to the plain preview lines the generic file card shows — no error
 * banner, because a file that will not render is still a file to open.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type AttachmentPreview } from '../../lib/team-chat-api'
import { fileTypeMeta } from '../../lib/file-type'
import { formatFileSize } from '../../lib/composer-attachments'
import { openMessageLinkInApp } from '../../lib/team-chat-links'
import { SURFACE_COLORS } from '../../lib/surface-tokens'
import { useResolvedTheme } from '../../contexts/theme'
import { ChatMarkdown } from '../chat/ChatMarkdown'
import { AttachmentPreviewBody } from './AttachmentPreviewBody'
import { DownloadBadge } from './FileAttachmentCard'

const api = teamChatApi()

/** One read of the route: its default page, and the total it will serve. */
const PAGE_CHARS = 20_000
export const MARKDOWN_MAX_CHARS = 60_000

/**
 * Collapsed height of the rendered body — a whole number of card body lines
 * (12/18 type scale), so the clamp never lands mid-glyph. Taller on web, where
 * a channel has the room a phone does not.
 */
export const MARKDOWN_CLAMP_HEIGHT = Platform.OS === 'web' ? 440 : 320

interface MarkdownBody {
  text: string
  nextOffset: number | null
}

/**
 * Whether a body is long enough to need the clamp before it has been measured.
 * Markdown has no `numberOfLines`, so the real signal is the rendered height;
 * this covers the first frame and any surface that does not report layout.
 */
const CLAMP_LINE_HINT = 28
const CLAMP_CHAR_HINT = 3_600

export function markdownOverflowsClamp(text: string): boolean {
  return text.length > CLAMP_CHAR_HINT || text.split('\n').length > CLAMP_LINE_HINT
}

/**
 * Bodies already fetched, by attachment id. A channel scrolls the same message
 * past the viewport many times; the paste does not change, so neither does the
 * body. Module-level because it outlives any one row.
 */
const bodyCache = new Map<string, MarkdownBody>()

async function fetchPage(attachmentId: string, offset: number): Promise<MarkdownBody | null> {
  const page = await api.fileText(attachmentId, { raw: true, offset, limit: PAGE_CHARS })
  if (page.text === null) return null
  return { text: page.text, nextOffset: page.nextOffset }
}

export interface MarkdownAttachmentBodyProps {
  attachmentId: string
  /** The server's plain sample, painted while the real body is in flight. */
  preview?: AttachmentPreview | null
}

/**
 * The rendered body of a pasted markdown attachment, with its clamp and its
 * Show more. Exported for the card below and for tests that do not want the
 * header.
 */
export function MarkdownAttachmentBody({ attachmentId, preview }: MarkdownAttachmentBodyProps) {
  const [body, setBody] = useState<MarkdownBody | null>(() => bodyCache.get(attachmentId) ?? null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'plain'>(() =>
    bodyCache.has(attachmentId) ? 'ready' : 'loading',
  )
  const [expanded, setExpanded] = useState(false)
  const [paging, setPaging] = useState(false)
  const [fullHeight, setFullHeight] = useState(0)
  const theme = useResolvedTheme()

  useEffect(() => {
    const cached = bodyCache.get(attachmentId)
    if (cached) {
      setBody(cached)
      setStatus('ready')
      return
    }
    let live = true
    setBody(null)
    setStatus('loading')
    fetchPage(attachmentId, 0)
      .then((page) => {
        if (!live) return
        if (!page) {
          setStatus('plain')
          return
        }
        bodyCache.set(attachmentId, page)
        setBody(page)
        setStatus('ready')
      })
      .catch(() => {
        // A file the reader cannot fetch still opens from the card's footer.
        if (live) setStatus('plain')
      })
    return () => {
      live = false
    }
  }, [attachmentId])

  /** Expand in place and page whatever the first read did not cover. */
  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (!body?.nextOffset || paging || body.text.length >= MARKDOWN_MAX_CHARS) return
    setPaging(true)
    try {
      let merged = body
      while (merged.nextOffset && merged.text.length < MARKDOWN_MAX_CHARS) {
        const next = await fetchPage(attachmentId, merged.nextOffset).catch(() => null)
        if (!next?.text) break
        merged = { text: merged.text + next.text, nextOffset: next.nextOffset }
        bodyCache.set(attachmentId, merged)
        setBody(merged)
      }
    } finally {
      setPaging(false)
    }
  }, [attachmentId, body, expanded, paging])

  const cardColor = theme === 'dark' ? SURFACE_COLORS.dark.container : SURFACE_COLORS.light.container
  // `transparent` in the card's own colour: a fade has to end where the card
  // does, and the theme colour is the only thing that guarantees it.
  const fade = useMemo(() => [`${cardColor}00`, `${cardColor}E6`] as const, [cardColor])

  if (status !== 'ready' || !body) {
    // Exactly what the file card shows today: the same sample, no spinner, no
    // banner. On failure this is also the final state.
    return <AttachmentPreviewBody preview={preview} />
  }

  const overflows = fullHeight > MARKDOWN_CLAMP_HEIGHT || markdownOverflowsClamp(body.text)
  const clamped = overflows && !expanded

  return (
    <View className="border-t border-border/60" testID="pasted-markdown-body">
      <View style={clamped ? { maxHeight: MARKDOWN_CLAMP_HEIGHT, overflow: 'hidden' } : undefined}>
        <View
          className="px-3 py-2"
          testID="pasted-markdown-content"
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height
            setFullHeight((prev) => (prev === height ? prev : height))
          }}
        >
          <ChatMarkdown isStreaming={false} variant="card" onLinkPress={openMessageLinkInApp}>
            {body.text}
          </ChatMarkdown>
        </View>
        {clamped ? (
          <LinearGradient
            pointerEvents="none"
            colors={fade}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44 }}
            testID="pasted-markdown-fade"
          />
        ) : null}
      </View>
      <View className="flex-row items-center justify-between gap-3 border-t border-border/60 px-3 py-1.5">
        {overflows ? (
          <Pressable
            onPress={() => void toggle()}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Show less of the file' : 'Show more of the file'}
            testID="pasted-markdown-toggle"
          >
            <Text className="text-[11px] font-medium text-primary">
              {expanded ? 'Show less' : paging ? 'Show more…' : 'Show more'}
            </Text>
          </Pressable>
        ) : (
          <View />
        )}
        {body.nextOffset && expanded ? (
          <Text className="text-[10px] text-muted-foreground">Open the file to read the rest</Text>
        ) : null}
      </View>
    </View>
  )
}

export interface PastedMarkdownCardProps {
  attachmentId: string
  /** File name as uploaded (`Pasted markdown.md`). */
  name: string
  mimeType?: string | null
  size?: number | null
  /** Absolute URL of the stored file. */
  url: string
  preview?: AttachmentPreview | null
  /** Opens the file viewer — the whole document, past the clamp. */
  onOpen?: () => void
  className?: string
}

/**
 * A pasted markdown attachment in the timeline: the file header the generic
 * card has, over the rendered markdown itself. Sized like a message rather than
 * like a file tile, because it is prose to read.
 */
export function PastedMarkdownCard({
  attachmentId,
  name,
  mimeType,
  size,
  url,
  preview,
  onOpen,
  className,
}: PastedMarkdownCardProps) {
  const meta = fileTypeMeta(name, mimeType)
  const subtitle = [meta.label, typeof size === 'number' && size > 0 ? formatFileSize(size) : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <View
      className={cn(
        // Chat width, not file-tile width: `w-full` inside the row plus the cap
        // is `min(100%, 48rem)` without a `min()` native layout cannot read.
        'relative w-full max-w-[48rem] overflow-hidden rounded-xl border border-border bg-card',
        className,
      )}
      testID="pasted-markdown-card"
    >
      <View className="relative flex-row items-center gap-3 p-3">
        <View
          className="h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: meta.color }}
        >
          <Text className="text-[11px] font-bold text-white" numberOfLines={1}>
            {meta.glyph}
          </Text>
        </View>
        {/* Room kept on the right so a long name never runs under the badge. */}
        <View className="min-w-0 flex-1 pr-10">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <DownloadBadge url={url} name={name} />
      </View>
      <MarkdownAttachmentBody attachmentId={attachmentId} preview={preview} />
      {onOpen ? (
        <Pressable
          onPress={onOpen}
          accessibilityRole="link"
          accessibilityLabel={`Open ${name}`}
          className="border-t border-border/60 px-3 py-2 active:bg-muted"
          testID="pasted-markdown-open"
        >
          <Text className="text-[11px] font-medium text-primary">Open file</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
