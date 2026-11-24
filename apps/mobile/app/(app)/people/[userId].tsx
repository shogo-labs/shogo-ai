// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** A person's profile, full screen — what phone widths open instead of the pane. */
import { View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { UserProfileScreen } from '../../../components/team-chat/UserProfileScreen'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { Spinner } from '@/components/ui/spinner'

/**
 * `observer`: `useActiveWorkspace` reads the workspaces collection, which is
 * empty until its request lands. Opened by URL there is nothing else to
 * re-render this route, so without the subscription the gate below stays on
 * its spinner for good (SHO-490).
 */
export default observer(function UserProfileRoute() {
  const params = useLocalSearchParams<{ userId?: string | string[] }>()
  const userId = Array.isArray(params.userId) ? params.userId[0] : params.userId
  const workspace = useActiveWorkspace()
  if (!workspace?.id || !userId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Spinner />
      </View>
    )
  }
  return <UserProfileScreen key={`${workspace.id}:${userId}`} workspaceId={workspace.id} userId={userId} />
})
