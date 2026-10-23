// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** A person's profile, full screen — what phone widths open instead of the pane. */
import { ActivityIndicator, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { UserProfileScreen } from '../../../components/team-chat/UserProfileScreen'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'

export default function UserProfileRoute() {
  const params = useLocalSearchParams<{ userId?: string | string[] }>()
  const userId = Array.isArray(params.userId) ? params.userId[0] : params.userId
  const workspace = useActiveWorkspace()
  if (!workspace?.id || !userId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    )
  }
  return <UserProfileScreen key={`${workspace.id}:${userId}`} workspaceId={workspace.id} userId={userId} />
}
