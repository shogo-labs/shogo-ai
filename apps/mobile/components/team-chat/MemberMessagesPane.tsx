// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every message one member sent in a conversation — top-level posts and thread
 * replies — newest first, with a switcher so you can look at someone else
 * without closing the pane (SHO-419). Tapping a row jumps the channel to that
 * message in context.
 *
 * A pane rather than a filter on the live timeline: the timeline has its own
 * cache, cursors and realtime merge, and a second "mode" inside it would fight
 * all three.
 */
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View } from 'react-native'
import { MessageSquare, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { AgentAvatar } from './AgentAvatar'
import { UserAvatar } from './UserAvatar'
import { InlineMarkdown } from './InlineMarkdown'
import { useMemberMessages } from '../../hooks/useMemberMessages'
import { formatTime } from '../../lib/team-chat-time'
import { memberForKey, memberFromKey } from '../../lib/member-messages'
import type { ChatMessage, ConversationDetail, ConversationMember } from '../../lib/team-chat-api'

export interface MemberMessagesPaneProps {
  workspaceId: string
  conversation: ConversationDetail
  /** `user:<userId>` | `agent:<projectId>` | `agent:ws` */
  from: string
  onClose: () => void
  /** The switcher picked someone else; the host reopens the pane on that key. */
  onChangeMember: (from: string) => void
  onShowInChat: (message: ChatMessage) => void
}

/** "#launch" for a channel, "this conversation" for a DM. */
function conversationLabel(conversation: ConversationDetail): string {
  const channel = conversation.kind === 'public' || conversation.kind === 'private' || conversation.kind === 'activity'
  return channel ? `#${conversation.name ?? 'channel'}` : 'this conversation'
}

function memberName(member: ConversationMember | null): string {
  if (!member) return 'This member'
  return member.name?.trim() || (member.type === 'agent' ? 'Agent' : 'Someone')
}

function MemberAvatar({ member, workspaceId, size }: { member: ConversationMember; workspaceId: string; size: number }) {
  return member.type === 'agent' ? (
    <AgentAvatar name={memberName(member)} projectId={member.projectId} workspaceId={workspaceId} size={size} />
  ) : (
    <UserAvatar name={memberName(member)} image={member.image} size={size} />
  )
}

export function MemberMessagesPane({
  workspaceId,
  conversation,
  from,
  onClose,
  onChangeMember,
  onShowInChat,
}: MemberMessagesPaneProps) {
  const member = memberForKey(conversation.members, from)
  const name = memberName(member)
  const label = conversationLabel(conversation)
  const { messages, loading, loadingMore, error, hasMore, loadMore } = useMemberMessages(workspaceId, conversation.id, from)

  return (
    <View className="flex-1 bg-background" testID="member-messages-pane">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <MessageSquare size={16} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
          Messages from {name}
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close member messages"
          testID="member-messages-close"
          className="rounded-md p-1 active:bg-muted"
        >
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5 px-3 py-2"
        className="max-h-14 border-b border-border"
        testID="member-messages-switcher"
      >
        {conversation.members.map((m) => {
          const key = memberFromKey(m)
          const active = key === from
          return (
            <Pressable
              key={m.id}
              onPress={() => onChangeMember(key)}
              accessibilityRole="button"
              accessibilityLabel={`Messages from ${memberName(m)}`}
              accessibilityState={{ selected: active }}
              testID={`member-messages-switch-${key}`}
              className={cn(
                'flex-row items-center gap-1.5 rounded-full border px-2 py-1 active:bg-muted',
                active ? 'border-primary bg-primary/10' : 'border-border',
              )}
            >
              <MemberAvatar member={m} workspaceId={workspaceId} size={18} />
              <Text
                className={cn('max-w-32 text-xs', active ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                numberOfLines={1}
              >
                {memberName(m)}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
      {error ? <Text className="px-3 py-2 text-xs text-destructive">{error}</Text> : null}
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MemberMessageRow message={item} onPress={() => onShowInChat(item)} />}
        onEndReached={hasMore ? () => void loadMore() : undefined}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          loading ? (
            <View className="items-center py-10">
              <ActivityIndicator />
            </View>
          ) : (
            <Text className="px-6 py-10 text-center text-sm text-muted-foreground" testID="member-messages-empty">
              {name} hasn’t posted in {label} yet.
            </Text>
          )
        }
        ListFooterComponent={loadingMore ? <View className="items-center py-3"><ActivityIndicator size="small" /></View> : null}
      />
    </View>
  )
}

function MemberMessageRow({ message, onPress }: { message: ChatMessage; onPress: () => void }) {
  const date = new Date(message.createdAt)
  const when = `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${formatTime(message.createdAt)}`
  const inThread = !!message.threadRootId
  const deleted = !!message.deletedAt
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Show message from ${when} in the channel`}
      testID={`member-message-${message.id}`}
      className="border-b border-border/60 px-3 py-2 active:bg-muted"
    >
      <View className="flex-row items-center gap-2">
        <Text className="text-[11px] text-muted-foreground">{when}</Text>
        {inThread ? (
          <View className="rounded bg-muted px-1.5 py-px">
            <Text className="text-[10px] font-medium text-muted-foreground">in thread</Text>
          </View>
        ) : null}
      </View>
      {deleted ? (
        <Text className="mt-0.5 text-sm italic text-muted-foreground">This message was deleted.</Text>
      ) : (
        <InlineMarkdown text={message.text} numberOfLines={3} className="mt-0.5 text-sm text-foreground" />
      )}
      {message.attachments.length ? (
        <Text className="mt-0.5 text-[11px] text-muted-foreground">
          {message.attachments.length} {message.attachments.length === 1 ? 'attachment' : 'attachments'}
        </Text>
      ) : null}
    </Pressable>
  )
}
