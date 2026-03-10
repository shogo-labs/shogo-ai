// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Catch-all route for the integrations OAuth callback deep link.
 *
 * On Android, the JS redirect from the callback page opens the app via intent
 * rather than through openAuthSessionAsync's interception. This route prevents
 * the "Unmatched Route" error by redirecting back to the originating project.
 * The ConnectToolWidget's on-mount check will detect the active connection
 * and send the confirmation message to the agent.
 */
import { Redirect, useLocalSearchParams } from "expo-router"

export default function IntegrationsCallback() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>()

  if (projectId) {
    return <Redirect href={`/(app)/projects/${projectId}?fromOAuth=1`} />
  }
  return <Redirect href="/" />
}
