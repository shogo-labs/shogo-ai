// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shows desktop/OS alerts for mentions, DMs, and thread replies while the
 * app is open. The server sends these over the realtime socket instead of a
 * phone push when you're active; the conversation on screen stays quiet.
 */
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { useActiveConversationId } from '../../hooks/useTeamChat'
import { useTeamChatEvents } from '../../lib/team-chat-connection'
import { useWorkspaceChatMode } from '../../hooks/useWorkspaceChatMode'
import { nativeChatVisible } from '../../lib/team-chat-api'
import { isUserInactive, notifyChannelMessage } from '../../lib/notifications/chat-notifier'

export function TeamChatNotifier() {
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const teamWorkspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const { config } = useWorkspaceChatMode(teamWorkspaceId)
  const workspaceId = nativeChatVisible(config?.mode) ? teamWorkspaceId : null
  const active = useActiveConversationId()
  const activeRef = useRef(active)
  activeRef.current = active
  const foreground = useRef(AppState.currentState === 'active')

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      foreground.current = s === 'active'
    })
    return () => sub.remove()
  }, [])

  useTeamChatEvents(workspaceId, (event) => {
    if (event.type !== 'notification') return
    void (async () => {
      const onScreen = activeRef.current === event.conversationId && foreground.current && !(await isUserInactive())
      if (onScreen) return
      await notifyChannelMessage({
        // Reminders without a message have no conversation; `/c/inbox` is the inbox screen.
        conversationId: event.conversationId ?? 'inbox',
        messageId: event.messageId ?? `reminder-${Date.now()}`,
        threadRootId: event.threadRootId,
        title: event.title,
        body: event.body,
      })
    })()
  })

  return null
}
