// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A file an agent attached to its message, shown in place: the copy taken
 * when it posted, so what people read is what they approve. Collapsed to a
 * preview; expands to the whole copy, and opens the live file in the project.
 */
import { useState } from 'react'
import { Linking, Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronDown, ChevronUp, ExternalLink, FileText } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { ChatMarkdown } from '../chat/ChatMarkdown'
import { shortVersion, type MessageArtifact } from '../../lib/team-chat-kinds'

const PREVIEW_LINES = 12
const MARKDOWN_RE = /\.(md|mdx|markdown)$/i

function preview(content: string): { text: string; cut: boolean } {
  const lines = content.split('\n')
  return lines.length > PREVIEW_LINES ? { text: lines.slice(0, PREVIEW_LINES).join('\n'), cut: true } : { text: content, cut: false }
}

export function ArtifactCard({ artifact, onOpenLink }: { artifact: MessageArtifact; onOpenLink?: (url: string) => boolean }) {
  const [open, setOpen] = useState(false)
  const { text, cut } = preview(artifact.content)
  const expandable = cut || !!artifact.truncated
  const shown = open ? artifact.content : text
  const markdown = MARKDOWN_RE.test(artifact.path)
  return (
    <View className="mt-1 max-w-[560px] overflow-hidden rounded-lg border border-border bg-card" testID="artifact-card">
      <View className="flex-row items-center gap-2 border-b border-border/60 px-3 py-2">
        <FileText size={13} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-xs font-semibold text-foreground" numberOfLines={1}>{artifact.path}</Text>
        <Text className="font-mono text-[10px] text-muted-foreground" accessibilityLabel={`Version ${shortVersion(artifact.sha256)}`}>
          {shortVersion(artifact.sha256)}
        </Text>
        {artifact.url ? (
          <Pressable
            onPress={() => { if (!onOpenLink?.(artifact.url!)) void Linking.openURL(artifact.url!) }}
            accessibilityRole="link"
            accessibilityLabel={`Open ${artifact.name} in the project`}
            className="flex-row items-center gap-1 rounded px-1.5 py-0.5 active:bg-muted"
            testID="artifact-open"
          >
            <ExternalLink size={11} className="text-primary" />
            <Text className="text-[11px] font-medium text-primary">Open</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={open ? { maxHeight: 520 } : undefined} scrollEnabled={open} nestedScrollEnabled className="px-3 py-2">
        {markdown ? (
          <ChatMarkdown isStreaming={false} onLinkPress={onOpenLink}>{shown}</ChatMarkdown>
        ) : (
          <Text className="font-mono text-[12px] text-foreground" selectable>{shown}</Text>
        )}
        {open && artifact.truncated ? (
          <Text className="mt-2 text-[11px] text-muted-foreground">Too long to show here in full. Open it in the project for the rest.</Text>
        ) : null}
      </ScrollView>
      {expandable ? (
        <Pressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          className={cn('flex-row items-center justify-center gap-1 border-t border-border/60 py-1.5 active:bg-muted')}
          testID="artifact-toggle"
        >
          {open ? <ChevronUp size={12} className="text-primary" /> : <ChevronDown size={12} className="text-primary" />}
          <Text className="text-[11px] font-medium text-primary">{open ? 'Show less' : `Show all of ${artifact.name}`}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
