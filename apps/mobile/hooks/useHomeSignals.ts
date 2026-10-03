// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What team Home surfaces first: agents working now, things that need the
 * person (failed agent work, mentions), and starred conversations. Shared by
 * the desktop Home panel and the phone Home feed.
 */
import { useMemo } from 'react'
import { useRouter } from 'expo-router'
import { useAgentActivity } from './useAgentActivity'
import { buildFeed, type ActivityEntry } from '../lib/activity-feed'
import { openActiveChat } from '../lib/open-active-chat'
import { useTeamChatNav } from '../components/team-chat/TeamChatSidebarProvider'

export function useHomeSignals(opts: { polling?: boolean } = {}) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const activity = useAgentActivity({ light: true, polling: opts.polling })
  const running = useMemo(() => buildFeed({ inbox: [], tasks: activity.tasks, activeChats: activity.activeChats }).running, [activity.tasks, activity.activeChats])
  const failed = useMemo(
    () => buildFeed({ inbox: [], tasks: activity.tasks, activeChats: [], filter: 'agents', unreadOnly: true }).entries,
    [activity.tasks],
  )
  const mentions = useMemo(() => chat.list.filter((c) => !c.archivedAt && !c.muted && c.mentionCount > 0), [chat.list])
  const starred = useMemo(() => chat.list.filter((c) => c.starred && !c.archivedAt), [chat.list])
  const unread = useMemo(
    () => chat.list.filter((c) => !c.archivedAt && !c.muted && c.unreadCount > 0 && c.mentionCount === 0 && !c.starred),
    [chat.list],
  )

  /** Open an agent's running chat or task; falls back to the workspace agent. */
  const openEntry = (entry: ActivityEntry) => {
    if (entry.agent?.chat) return openActiveChat(router, entry.agent.chat)
    const task = entry.agent?.task
    if (task?.projectId) {
      router.push({
        pathname: '/(app)/projects/[id]',
        params: { id: task.projectId, ...(task.chatSessionId ? { chatSessionId: task.chatSessionId } : {}) },
      } as any)
    } else {
      router.push('/(app)/agent' as any)
    }
  }

  return { chat, activity, running, failed, mentions, starred, unread, openEntry, needsYou: failed.length + mentions.length }
}
