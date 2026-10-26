// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat preferences used to live here. They are now Settings → Chat, built
 * from the same cards and rows as the other settings tabs. This route stays
 * as a redirect forever: old deep links (the weekly digest email, bookmarks,
 * older app builds) must keep landing on the right place.
 */
import { Redirect } from 'expo-router'

export default function ChatSettingsRedirect() {
  return <Redirect href="/(app)/settings?tab=chat" />
}
