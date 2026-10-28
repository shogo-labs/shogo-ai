// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The sample of a file's content drawn inside its attachment card: a few lines
 * of a document or a PDF, slide 1 of a deck, the first rows of a spreadsheet,
 * or a snippet of source.
 *
 * Every piece of it is user-supplied, so it is rendered with plain <Text> and
 * never interpreted — no markup, no links, no image URLs from the file body.
 *
 * Renders nothing when there is no preview. That keeps the card identical to
 * the file-only version for files the server could not read, and means a
 * preview that arrives later (as `message.updated`, because extraction finished
 * after the message was sent) grows the card downward instead of replacing what
 * was already on screen.
 */

import { ScrollView, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { AttachmentPreview } from '../../lib/team-chat-api'

/** Prose and code are clamped; the server may send a couple of lines more. */
const MAX_VISIBLE_LINES = 6

export interface AttachmentPreviewBodyProps {
  preview?: AttachmentPreview | null
  className?: string
}

export function AttachmentPreviewBody({ preview, className }: AttachmentPreviewBodyProps) {
  if (!preview) return null

  return (
    <View
      className={cn('border-t border-border/60 px-3 pb-2.5 pt-2', className)}
      testID={`attachment-preview-${preview.kind}`}
    >
      {preview.kind === 'text' && (
        <Text className="text-xs leading-5 text-muted-foreground" numberOfLines={MAX_VISIBLE_LINES}>
          {preview.lines.join('\n')}
        </Text>
      )}

      {preview.kind === 'code' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 8 }}>
          <Text className="font-mono text-[11px] leading-5 text-muted-foreground" numberOfLines={MAX_VISIBLE_LINES}>
            {preview.lines.join('\n')}
          </Text>
        </ScrollView>
      )}

      {preview.kind === 'slides' && (
        <View className="gap-0.5">
          {!!preview.title && (
            <Text className="text-xs font-semibold text-foreground" numberOfLines={2}>
              {preview.title}
            </Text>
          )}
          {preview.bullets.map((bullet, index) => (
            <Text key={index} className="text-xs leading-4 text-muted-foreground" numberOfLines={1}>
              {`• ${bullet}`}
            </Text>
          ))}
          {preview.count > 1 && (
            <Text className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {`Slide 1 of ${preview.count}`}
            </Text>
          )}
        </View>
      )}

      {preview.kind === 'table' && (
        <View>
          {!!preview.sheet && (
            <Text className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{preview.sheet}</Text>
          )}
          {preview.rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              className={cn('flex-row gap-3 py-0.5', rowIndex === 0 && 'border-b border-border/60 pb-1')}
            >
              {row.map((cell, cellIndex) => (
                <Text
                  key={cellIndex}
                  className={cn(
                    'flex-1 text-[11px] text-muted-foreground',
                    rowIndex === 0 && 'font-semibold text-foreground',
                  )}
                  numberOfLines={1}
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
          {preview.truncated && (
            <Text className="mt-1 text-[10px] text-muted-foreground">Showing the first rows</Text>
          )}
        </View>
      )}
    </View>
  )
}
