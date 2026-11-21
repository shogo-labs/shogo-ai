// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** An agent's profile; `key` is a project id, or `ws` for the workspace agent. */
import { ActivityIndicator, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { AgentProfileScreen } from '../../../components/team-chat/AgentProfileScreen'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'

/**
 * `observer`: `useActiveWorkspace` reads the workspaces collection, which is
 * empty until its request lands. Opened by URL there is nothing else to
 * re-render this route, so without the subscription the gate below stays on
 * its spinner for good (SHO-490).
 */
export default observer(function AgentProfileRoute() {
  const params = useLocalSearchParams<{ key?: string | string[] }>()
  const key = Array.isArray(params.key) ? params.key[0] : params.key
  const workspace = useActiveWorkspace()
  if (!workspace?.id) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    )
  }
  return <AgentProfileScreen key={`${workspace.id}:${key}`} workspaceId={workspace.id} agentKey={key} />
})
