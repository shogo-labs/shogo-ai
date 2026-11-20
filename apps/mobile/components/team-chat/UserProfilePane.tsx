// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's profile in the conversation's side pane, beside the timeline on
 * wide screens. Phone widths get the full-screen page instead
 * (`/(app)/people/[userId]`); both render the same body.
 *
 * Opened from a channel, it also offers that channel's "Messages from <name>"
 * list (SHO-419) — the profile is where you look someone up, so it is where you
 * ask what they have said here.
 */
import { Pressable, Text, View } from 'react-native'
import { MessageSquare, UserRound, X } from 'lucide-react-native'
import { UserProfileBody } from './UserProfileBody'
import { userFromKey } from '../../lib/member-messages'
import type { ConversationDetail } from '../../lib/team-chat-api'

export function UserProfilePane({
  workspaceId,
  userId,
  conversation,
  onFilterByMember,
  onClose,
}: {
  workspaceId: string
  userId: string
  /** The channel the profile was opened from, when there is one. */
  conversation?: ConversationDetail | null
  onFilterByMember?: (from: string) => void
  onClose: () => void
}) {
  // Activity channels are left out on purpose: they post-filter `canSeeMessage`
  // after the page is taken, so a filtered page can come back short. The header
  // action is hidden there for the same reason.
  const channel =
    conversation && (conversation.kind === 'public' || conversation.kind === 'private') ? conversation : null
  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-2.5">
        <UserRound size={16} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-base font-semibold text-foreground">Profile</Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close profile" testID="user-profile-close" className="rounded-md p-1 active:bg-muted">
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      {channel && onFilterByMember ? (
        <Pressable
          onPress={() => onFilterByMember(userFromKey(userId))}
          accessibilityRole="button"
          accessibilityLabel={`Messages in #${channel.name ?? 'channel'}`}
          testID="user-profile-member-messages"
          className="flex-row items-center gap-2 border-b border-border px-4 py-2 active:bg-muted"
        >
          <MessageSquare size={14} className="text-muted-foreground" />
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
            Messages in #{channel.name ?? 'channel'}
          </Text>
        </Pressable>
      ) : null}
      <UserProfileBody key={userId} workspaceId={workspaceId} userId={userId} onClose={onClose} />
    </View>
  )
}
