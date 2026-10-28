// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's profile in the conversation's side pane, beside the timeline on
 * wide screens. Phone widths get the full-screen page instead
 * (`/(app)/people/[userId]`); both render the same body.
 */
import { Pressable, Text, View } from 'react-native'
import { UserRound, X } from 'lucide-react-native'
import { UserProfileBody } from './UserProfileBody'

export function UserProfilePane({
  workspaceId,
  userId,
  onClose,
}: {
  workspaceId: string
  userId: string
  onClose: () => void
}) {
  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-2.5">
        <UserRound size={16} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-base font-semibold text-foreground">Profile</Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close profile" testID="user-profile-close" className="rounded-md p-1 active:bg-muted">
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      <UserProfileBody key={userId} workspaceId={workspaceId} userId={userId} onClose={onClose} />
    </View>
  )
}
