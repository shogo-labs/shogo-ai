// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's full profile page: their photo, status, local time, and the
 * things you can do with them. Phone widths open this instead of the side
 * pane; both render the same body.
 */
import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { usePresenceFeed } from '../../hooks/usePresence'
import { useStatusFeed } from '../../hooks/useChatPrefs'
import { UserProfileBody } from './UserProfileBody'

export function UserProfileScreen({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const router = useRouter()
  // The feeds this page reads are mounted by the conversation screen; opening
  // the page directly (a deep link, a notification) has to mount them itself.
  usePresenceFeed(workspaceId)
  useStatusFeed(workspaceId)

  const goBack = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/c' as any)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" testID="user-profile-screen">
      <View className="flex-row items-center px-2 py-2">
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" className="rounded-lg p-2 active:bg-muted">
          <ChevronLeft size={22} className="text-foreground" />
        </Pressable>
      </View>
      <UserProfileBody workspaceId={workspaceId} userId={userId} avatarSize={128} />
    </SafeAreaView>
  )
}
