// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shows desktop/OS alerts for mentions, DMs, and thread replies while the
 * app is open. The server sends these over the realtime socket to every open
 * client (and a phone push when you aren't active anywhere); the conversation
 * on screen stays quiet.
 *
 * In the browser and desktop app, the message cue plays from here whether or
 * not OS banners are allowed, so a message is audible even when Chrome or
 * Safari shows the banner silently or not at all.
 */
import { useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { useActiveConversationId } from '../../hooks/useTeamChat'
import { useChatSettings } from '../../hooks/useChatPrefs'
import { useTeamChatEvents } from '../../lib/team-chat-connection'
import { useWorkspaceChatMode } from '../../hooks/useWorkspaceChatMode'
import { nativeChatVisible } from '../../lib/team-chat-api'
import { isUserInactive, notifyChannelMessage, requestAttention } from '../../lib/notifications/chat-notifier'
import { armPermissionNudge } from '../../lib/notifications/permission-nudge'
import {
  messageSoundKindFor,
  playMessageSound,
  unlockNotificationAudio,
} from '../../lib/notification-sound'

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
  // Only the workspace that's open is listened to, so this is its own setting.
  // Phones play the system push sound, so only the web and desktop builds need this.
  const { settings } = useChatSettings(Platform.OS === 'web' ? workspaceId : null)
  const messageSoundRef = useRef(settings?.messageSound ?? 'default')
  messageSoundRef.current = settings?.messageSound ?? 'default'

  useEffect(() => {
    unlockNotificationAudio()
  }, [])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      foreground.current = s === 'active'
    })
    return () => sub.remove()
  }, [])

  useTeamChatEvents(workspaceId, (event) => {
    if (event.type !== 'notification') return
    // A backgrounded phone gets the server push instead; a local alert too would double it.
    if (Platform.OS !== 'web' && !foreground.current) return
    void (async () => {
      const onScreen = activeRef.current === event.conversationId && foreground.current && !(await isUserInactive())
      if (onScreen) return
      // The first DM or mention that arrives while away asks for alert permission inline.
      armPermissionNudge(event.reason)
      // Plays whether or not banner permission is granted; the server already
      // skipped users in DND or quiet hours.
      const played = playMessageSound(messageSoundKindFor(event.reason), messageSoundRef.current)
      void requestAttention(event.reason)
      await notifyChannelMessage({
        // Reminders without a message have no conversation; `/c/inbox` is the inbox screen.
        conversationId: event.conversationId ?? 'inbox',
        messageId: event.messageId ?? `reminder-${Date.now()}`,
        threadRootId: event.threadRootId,
        title: event.title,
        body: event.body,
        reason: event.reason,
        silent: played,
      })
    })()
  })

  return null
}
