// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `/c/new?mode=message|agent|channel`: the phone's full-screen "New message" and
 * "Create channel". It is a route rather than a modal so Back works and the
 * keyboard has the whole screen.
 */
import { useLocalSearchParams } from 'expo-router'
import { NewConversationScreen, parseNewConversationMode } from '../../../components/team-chat/NewConversationScreen'

export default function NewConversationRoute() {
  const { mode } = useLocalSearchParams<{ mode?: string }>()
  return <NewConversationScreen mode={parseNewConversationMode(mode)} />
}
