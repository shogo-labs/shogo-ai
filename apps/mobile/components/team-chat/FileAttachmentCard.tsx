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
 * Previews are not drawn here yet: a real first-page image needs a server-side
 * conversion step, which is tracked separately. Pictures keep the inline
 * thumbnail they already had and gain the same download badge.
 */

import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Download } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { downloadAttachment } from '../../lib/attachment-download'
import { fileTypeMeta } from '../../lib/file-type'
import { formatFileSize } from '../../lib/composer-attachments'

export interface FileAttachmentCardProps {
  /** File name as uploaded, which is also the name it is saved under. */
  name: string
  mimeType?: string | null
  size?: number | null
  /** Absolute URL of the stored file. */
  url: string
  /** Tapping the card body, to keep whatever previewing it had. */
  onOpen?: () => void
  className?: string
}

/**
 * The corner download control. Shared with the picture attachments, so every
 * file in the timeline downloads from the same place.
 */
export function DownloadBadge({ url, name, className }: { url: string; name: string; className?: string }) {
  const [busy, setBusy] = useState(false)

  const onPress = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await downloadAttachment(url, name)
    } finally {
      setBusy(false)
    }
  }, [busy, url, name])

  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Download ${name}`}
      className={cn(
        'absolute right-2 top-2 h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/55 active:bg-black/75',
        className,
      )}
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : <Download size={15} color="#fff" />}
    </Pressable>
  )
}

export function FileAttachmentCard({ name, mimeType, size, url, onOpen, className }: FileAttachmentCardProps) {
  const meta = fileTypeMeta(name, mimeType)
  const subtitle = typeof size === 'number' && size > 0 ? `${meta.label} · ${formatFileSize(size)}` : meta.label

  return (
    <View
      className={cn('w-full max-w-[420px] overflow-hidden rounded-xl border border-border bg-card', className)}
      testID={`attachment-card-${name}`}
    >
      <Pressable
        onPress={onOpen}
        disabled={!onOpen}
        accessibilityRole={onOpen ? 'link' : undefined}
        accessibilityLabel={onOpen ? `Open ${name}` : undefined}
        className={cn('relative flex-row items-center gap-3 p-3', onOpen && 'active:bg-muted')}
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
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </Pressable>
      <DownloadBadge url={url} name={name} />
    </View>
  )
}
