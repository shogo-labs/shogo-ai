// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-line markdown for previews: bold, italic, strike, inline code, and
 * link labels. Block syntax is flattened first, because a heading or a list
 * cannot fit in a single truncated row.
 */
import { Text } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  flattenMarkdownBlocks,
  inlineMarkdownSegments,
  type InlineSegment,
} from '../../lib/team-chat-state'

export interface InlineMarkdownProps {
  text?: string
  /** Pre-parsed segments (search results already carry a match flag). */
  segments?: Array<InlineSegment & { match?: boolean }>
  className?: string
  numberOfLines?: number
  testID?: string
}

export function InlineMarkdown({ text, segments, className, numberOfLines, testID }: InlineMarkdownProps) {
  const parts = segments ?? inlineMarkdownSegments(flattenMarkdownBlocks(text ?? ''))
  return (
    <Text className={className} numberOfLines={numberOfLines} testID={testID}>
      {parts.map((seg, i) => (
        <Text
          key={i}
          className={cn(
            seg.bold && 'font-semibold',
            seg.italic && 'italic',
            seg.strike && 'line-through',
            seg.code && 'rounded bg-muted px-0.5 font-mono',
            seg.match && 'rounded bg-yellow-300/40 font-semibold',
          )}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  )
}
