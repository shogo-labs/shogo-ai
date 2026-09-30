// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A live timeline plus composer for one scope: a conversation's main view,
 * or a single thread when `threadRootId` is set.
 */
import { useCallback, useMemo } from 'react'
import { Alert, Platform, Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import type { ChatMessage, ConversationDetail, Mentionables } from '../../lib/team-chat-api'
import { mentionNames } from '../../lib/team-chat-state'
import { useConversationTimeline, useMarkReadWhileVisible, useTypingUsers } from '../../hooks/useTeamChat'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

export interface TimelinePaneProps {
  workspaceId: string
  conversation: ConversationDetail
  threadRootId?: string | null
  me: string | null
  mentionables: Mentionables | null
  visible: boolean
  header?: React.ReactElement | null
  onOpenThread?: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
  onClose?: () => void
  onJoin?: () => void
}

function confirmDelete(): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(typeof window === 'undefined' || window.confirm('Delete this message?'))
  return new Promise((resolve) =>
    Alert.alert('Delete message?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
    ]),
  )
}

function typingLabel(names: string[]): string | null {
  if (!names.length) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}

export function TimelinePane(props: TimelinePaneProps) {
  const { workspaceId, conversation, threadRootId = null, me, mentionables, visible } = props
  const timeline = useConversationTimeline(workspaceId, conversation.id, threadRootId)
  const typing = useTypingUsers(workspaceId, conversation.id, threadRootId)
  const names = useMemo(() => mentionNames(mentionables), [mentionables])
  const newestSeq = useMemo(() => {
    for (let i = timeline.state.messages.length - 1; i >= 0; i--) {
      const m = timeline.state.messages[i]!
      if (!m.pending && !m.threadRootId) return m.seq
    }
    return 0
  }, [timeline.state.messages])
  useMarkReadWhileVisible(threadRootId || !conversation.joined ? null : conversation.id, newestSeq, visible)

  const onReact = useCallback((m: ChatMessage, emoji: string) => void timeline.react(m.id, emoji).catch(() => {}), [timeline.react])
  const onEdit = useCallback((m: ChatMessage, text: string) => timeline.edit(m.id, text), [timeline.edit])
  const onDelete = useCallback(async (m: ChatMessage) => {
    if (await confirmDelete()) await timeline.remove(m.id).catch(() => {})
  }, [timeline.remove])
  const onStop = useCallback((m: ChatMessage) => void timeline.stopAgent(m.id).catch(() => {}), [timeline.stopAgent])

  const isChannel = conversation.kind === 'public' || conversation.kind === 'private'
  const placeholder = threadRootId
    ? 'Reply in thread…'
    : isChannel
      ? `Message #${conversation.name ?? 'channel'}`
      : 'Write a message…'
  const disabledReason = conversation.archivedAt
    ? 'This channel is archived.'
    : conversation.kind === 'activity'
      ? 'Activity is posted by Shogo. Reply in a thread to discuss.'
      : 'You do not have permission to post here.'
  const canPostHere = threadRootId ? conversation.canReply : conversation.canPost

  return (
    <View className="flex-1">
      {threadRootId && (
        <View className="flex-row items-center border-b border-border px-4 py-2.5">
          <Text className="flex-1 text-base font-semibold text-foreground">Thread</Text>
          {props.onClose && (
            <Pressable onPress={props.onClose} accessibilityLabel="Close thread" className="rounded-md p-1.5 active:bg-muted hover:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      )}
      {timeline.error && !timeline.state.messages.length ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Text className="text-center text-sm text-muted-foreground">{timeline.error}</Text>
          <Pressable onPress={() => void timeline.reload()} className="rounded-md bg-muted px-3 py-1.5">
            <Text className="text-sm text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : (
        <MessageList
          state={timeline.state}
          loading={timeline.loading}
          me={me}
          names={names}
          canManage={conversation.canManage}
          inThread={!!threadRootId}
          header={props.header}
          emptyText={threadRootId ? 'No replies yet.' : isChannel ? `This is the very beginning of #${conversation.name}.` : 'Say hello.'}
          onLoadOlder={threadRootId ? undefined : () => void timeline.loadOlder().catch(() => {})}
          onReply={props.onOpenThread}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
          onStopAgent={onStop}
          onRetry={timeline.retry}
          onDiscard={timeline.discard}
          onOpenSession={props.onOpenSession}
        />
      )}
      <View className="h-5 justify-center px-4">
        {typingLabel(typing) && <Text className="text-xs text-muted-foreground">{typingLabel(typing)}</Text>}
      </View>
      {!conversation.joined && isChannel && !threadRootId ? (
        <View className="items-center gap-2 border-t border-border px-4 py-3">
          <Text className="text-sm text-muted-foreground">You are viewing #{conversation.name}.</Text>
          <Pressable onPress={props.onJoin} className="rounded-md bg-primary px-4 py-1.5">
            <Text className="text-sm font-medium text-primary-foreground">Join channel</Text>
          </Pressable>
        </View>
      ) : (
        <Composer
          workspaceId={workspaceId}
          conversationId={conversation.id}
          threadRootId={threadRootId}
          placeholder={placeholder}
          mentionables={mentionables}
          me={me}
          disabled={!canPostHere}
          disabledReason={disabledReason}
          onSend={timeline.send}
        />
      )}
    </View>
  )
}
