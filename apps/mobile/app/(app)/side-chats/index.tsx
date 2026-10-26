// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Redirect } from 'expo-router'

/** Side chats now live in the workspace agent history. */
export default function SideChatsRedirect() {
  return <Redirect href="/(app)/agent" />
}
