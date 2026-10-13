// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Redirect, useLocalSearchParams } from 'expo-router'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Old side-chat links open that chat in the workspace agent. */
export default function SideChatRedirect() {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const id = firstParam(params.id)
  if (!id) return <Redirect href="/(app)/agent" />
  return <Redirect href={{ pathname: '/(app)/agent', params: { chatSessionId: id } }} />
}
