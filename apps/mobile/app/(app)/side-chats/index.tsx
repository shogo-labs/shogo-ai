// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Redirect } from 'expo-router'

/** Old side-chats index now redirects to the full Chats list. */
export default function SideChatsRedirect() {
  return <Redirect href="/(app)/chats" />
}
