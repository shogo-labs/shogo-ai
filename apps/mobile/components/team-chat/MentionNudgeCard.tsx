// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shown only to the sender, right above the composer, after they post a
 * channel message that mentions someone who isn't a member — same moment
 * Slack's "You mentioned @X, but they're not in this channel" nudge appears.
 * Not a real message: it's local UI state, never sent to the server or
 * cached with the timeline (see TimelinePane).
 */
import { Pressable, Text, View } from 'react-native'
import { joinNames } from '../../lib/team-chat-mention-nudge'

export interface MentionNudgeCardProps {
  names: string[]
  busy?: boolean
  error?: string | null
  onAdd: () => void
  onDismiss: () => void
  onDontShowAgain: () => void
}

export function MentionNudgeCard({ names, busy, error, onAdd, onDismiss, onDontShowAgain }: MentionNudgeCardProps) {
  if (!names.length) return null
  return (
    <View className="mx-4 mb-2 gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5" testID="mention-nudge-card">
      <Text className="text-xs text-foreground">
        You mentioned <Text className="font-semibold">{joinNames(names)}</Text>, but {names.length > 1 ? "they're" : "they're"} not in this channel.
      </Text>
      {error ? <Text className="text-[11px] text-destructive">{error}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          onPress={onAdd}
          disabled={busy}
          accessibilityLabel="Add them to this channel"
          className={`rounded-md bg-primary px-3 py-1.5 ${busy ? 'opacity-60' : ''}`}
        >
          <Text className="text-xs font-medium text-primary-foreground">{busy ? 'Adding…' : 'Add them'}</Text>
        </Pressable>
        <Pressable onPress={onDismiss} accessibilityLabel="Dismiss" className="rounded-md border border-border px-3 py-1.5 active:bg-muted">
          <Text className="text-xs text-foreground">Dismiss</Text>
        </Pressable>
        <Pressable onPress={onDontShowAgain} accessibilityLabel="Don't show this again" className="rounded-md px-3 py-1.5 active:bg-muted">
          <Text className="text-xs text-muted-foreground">Don't show again</Text>
        </Pressable>
      </View>
    </View>
  )
}
