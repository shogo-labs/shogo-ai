// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A file shared into a conversation: the tile that says what it is, the name,
 * and a download in the corner.
 *
 * Sized and shaped like the attachment cards people are used to from Slack, so
 * a deck or a report reads as a document rather than as a line of text. The
 * download sits in the top-right corner of the card, always visible — a
 * hover-only control would be unreachable on a phone, and this app runs on one.
 *
 * Under the header sits a short sample of the file's content
 * (`AttachmentPreviewBody`): the opening lines of a document or PDF, slide 1 of
 * a deck, the first rows of a spreadsheet. It is absent for anything the server
 * could not read, in which case the card is exactly the file-and-type card
 * above and nothing else.
 */

import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Download } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { downloadAttachment } from '../../lib/attachment-download'
import { fileTypeMeta } from '../../lib/file-type'
import { formatFileSize } from '../../lib/composer-attachments'
import { shareFileErrorText } from '../../lib/share-file-links'
import type { AttachmentPreview } from '../../lib/team-chat-api'
import { AttachmentPreviewBody } from './AttachmentPreviewBody'

export interface FileAttachmentCardProps {
  /** File name as uploaded, which is also the name it is saved under. */
  name: string
  mimeType?: string | null
  size?: number | null
  /** Absolute URL of the stored file. */
  url: string
  /** A sample of the file's content, when the server managed to read it. */
  preview?: AttachmentPreview | null
  /** Tapping the card body, to keep whatever previewing it had. */
  onOpen?: () => void
  className?: string
}

/**
 * The corner download control. Shared with the picture attachments, so every
 * file in the timeline downloads from the same place.
 *
 * `disabled` is for a file stored at 0 bytes: there is nothing to save, and
 * following the link would hand the browser a JSON error under the file's own
 * name, so the control is inert rather than misleading.
 */
export function DownloadBadge({
  url,
  name,
  className,
  disabled,
  disabledHint,
}: {
  url: string
  name: string
  className?: string
  disabled?: boolean
  disabledHint?: string
}) {
  const [busy, setBusy] = useState(false)

  const onPress = useCallback(async () => {
    if (busy || disabled) return
    setBusy(true)
    try {
      await downloadAttachment(url, name)
    } finally {
      setBusy(false)
    }
  }, [busy, disabled, url, name])

  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={busy || disabled}
      accessibilityRole="button"
      accessibilityLabel={disabled ? `Download ${name} unavailable` : `Download ${name}`}
      accessibilityHint={disabled ? disabledHint : undefined}
      accessibilityState={{ disabled: !!disabled }}
      className={cn(
        'absolute right-2 top-2 h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/55 active:bg-black/75',
        disabled && 'opacity-40',
        className,
      )}
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : <Download size={15} color="#fff" />}
    </Pressable>
  )
}

export function FileAttachmentCard({ name, mimeType, size, url, preview, onOpen, className }: FileAttachmentCardProps) {
  const meta = fileTypeMeta(name, mimeType)
  // A row stored at 0 bytes is a file that never really arrived. It is shown
  // as a failed upload rather than as a normal attachment, because the only
  // other thing a person can do with it is download nothing.
  const empty = typeof size === 'number' && size === 0
  const emptyText = shareFileErrorText('empty_file')
  const pages = preview?.kind === 'text' && preview.pages && preview.pages > 1 ? `${preview.pages} pages` : null
  const subtitle = empty
    ? 'Upload failed · 0 bytes'
    : [meta.label, pages, typeof size === 'number' && size > 0 ? formatFileSize(size) : null]
        .filter(Boolean)
        .join(' · ')

  return (
    <View
      className={cn('w-full max-w-[420px] overflow-hidden rounded-xl border border-border bg-card', className)}
      testID={`attachment-card-${name}`}
    >
      <Pressable
        onPress={empty ? undefined : onOpen}
        disabled={empty || !onOpen}
        accessibilityRole={empty ? undefined : onOpen ? 'link' : undefined}
        accessibilityLabel={empty ? `${name} — upload failed, 0 bytes` : onOpen ? `Open ${name}` : undefined}
        accessibilityHint={empty ? emptyText : undefined}
        className={cn('relative flex-row items-center gap-3 p-3', !empty && onOpen && 'active:bg-muted')}
      >
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
          <Text
            className={cn('mt-0.5 text-xs', empty ? 'text-destructive' : 'text-muted-foreground')}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        </View>
      </Pressable>
      {empty ? (
        <Text className="px-3 pb-3 text-[11px] text-muted-foreground" testID={`attachment-empty-${name}`}>
          {emptyText}
        </Text>
      ) : (
        <AttachmentPreviewBody preview={preview} />
      )}
      <DownloadBadge url={url} name={name} disabled={empty} disabledHint={emptyText} />
    </View>
  )
}
