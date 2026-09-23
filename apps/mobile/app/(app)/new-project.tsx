// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Preserved project-builder entry point.
 *
 * The workspace-agent shell owns `/`; this explicit route keeps the mature
 * builder flow available without making users discover it through Projects.
 * The builder implementation remains shared while it is incrementally
 * componentized.
 */
import { useLocalSearchParams } from 'expo-router'
import { HomeScreen } from './index'

export default function NewProjectScreen() {
  const { chatSessionId } = useLocalSearchParams<{ chatSessionId?: string | string[] }>()
  const originWorkspaceSessionId = Array.isArray(chatSessionId) ? chatSessionId[0] : chatSessionId
  return <HomeScreen forceBuilder originWorkspaceSessionId={originWorkspaceSessionId} />
}
