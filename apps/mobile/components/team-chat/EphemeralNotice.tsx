// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A notice only the reader can see — Slack's "Only visible to you" ephemeral.
 * Shown in the channel, attributed to Shogo, with the reader's own actions
 * underneath.
 *
 * Local UI state only: never sent to the server, never part of the timeline's
 * history, and gone as soon as the reader sends or leaves the conversation.
 */
import { Pressable, Text, View } from 'react-native'
import { Eye } from 'lucide-react-native'
import { ChatMarkdown } from '../chat/ChatMarkdown'
import type { MentionTarget } from '../chat/file-links'
import { formatTime } from '../../lib/team-chat-time'
import { renderMentionsMarkdown, type MentionNames } from '../../lib/team-chat-state'
import { AgentAvatar } from './AgentAvatar'

export interface EphemeralNoticeAction {
  label: string
  onPress: () => void
  /** Shown in place of `label` while the action is in flight. */
  busyLabel?: string
  busy?: boolean
  primary?: boolean
  accessibilityLabel?: string
}

export interface EphemeralNoticeProps {
  /** Wire text; `<@u:…>` tokens render as the usual highlighted mentions. */
  text: string
  names: MentionNames
  createdAt: string
  workspaceId?: string | null
  /** Slack's "Only visible to you" annotation. */
  ephemeralLabel?: boolean
  actions?: EphemeralNoticeAction[]
  error?: string | null
  /** Tapping a mention of a person or agent in `text`. */
  onMentionPress?: (target: MentionTarget) => void
  testID?: string
}

export function EphemeralNotice({
  text,
  names,
  createdAt,
  workspaceId,
  ephemeralLabel,
  actions = [],
  error,
  onMentionPress,
  testID = 'ephemeral-notice',
}: EphemeralNoticeProps) {
  return (
    <View className="px-4 pb-1 pt-2" testID={testID}>
      {ephemeralLabel ? (
        <View className="mb-1 flex-row items-center gap-1.5">
          <Eye size={12} className="text-muted-foreground" />
          <Text className="text-[11px] text-muted-foreground">Only visible to you</Text>
        </View>
      ) : null}
      <View className="flex-row gap-3">
        <AgentAvatar name="Shogo" projectId={null} workspaceId={workspaceId} size={32} />
        <View className="min-w-0 flex-1">
          <View className="flex-row items-baseline gap-2">
            <Text className="text-sm font-semibold text-foreground">Shogo</Text>
            <Text className="text-[11px] text-muted-foreground">{formatTime(createdAt)}</Text>
          </View>
          <ChatMarkdown isStreaming={false} onMentionPress={onMentionPress}>{renderMentionsMarkdown(text, names)}</ChatMarkdown>
          {error ? <Text className="mt-1 text-[11px] text-destructive">{error}</Text> : null}
          {actions.length ? (
            <View className="mt-2 flex-row flex-wrap gap-2">
              {actions.map((action) => (
                <Pressable
                  key={action.label}
                  onPress={action.onPress}
                  disabled={action.busy}
                  accessibilityLabel={action.accessibilityLabel ?? action.label}
                  className={
                    action.primary
                      ? `rounded-md bg-primary px-3 py-1.5 ${action.busy ? 'opacity-60' : ''}`
                      : 'rounded-md border border-border px-3 py-1.5 active:bg-muted'
                  }
                >
                  <Text className={action.primary ? 'text-xs font-medium text-primary-foreground' : 'text-xs text-foreground'}>
                    {action.busy && action.busyLabel ? action.busyLabel : action.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  )
}
