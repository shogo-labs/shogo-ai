// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The device scope of the workspace-agent chats list (SHO-391): who is signed
 * in, which server their workspace lives on, and which workspace it is.
 *
 * Every surface that reads or revalidates that list — the sidebar panel, the
 * phone drawer, the island and the landing chat — asks for its cache key here,
 * so they all land on the same file on the device *and* on the same in-flight
 * request.
 */
import { useMemo } from 'react'
import { useAuth } from '../contexts/auth'
import { useActiveInstance } from '../contexts/active-instance'
import { chatHistoryOrigin } from '../lib/chat-device-boot'
import { workspaceChatsKey } from '../lib/workspace-chats-cache'

export function useWorkspaceChatsCacheKey(
  workspaceId: string | null | undefined,
): string | null {
  const { user } = useAuth()
  const { instance } = useActiveInstance()
  const origin = chatHistoryOrigin(instance?.instanceId)
  return useMemo(
    () => workspaceChatsKey(user?.id, origin, workspaceId),
    [origin, user?.id, workspaceId],
  )
}
