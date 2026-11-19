// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One member's messages in a conversation — top-level posts and thread replies
 * — newest first, paged backwards (SHO-419). Refetches the first page when that
 * member posts, so the pane stays live while it is open.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { teamChatApi, type ChatMessage } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'
import { isFromMember } from '../lib/member-messages'

const api = teamChatApi()
const PAGE_SIZE = 50

export function useMemberMessages(workspaceId: string | null, conversationId: string | null, from: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    if (!conversationId || !from) return
    const gen = ++generation.current
    setLoading(true)
    try {
      const page = await api.messages(conversationId, { from, limit: PAGE_SIZE })
      if (gen !== generation.current) return
      setMessages(page.messages)
      setHasMore(page.hasMore)
      setError(null)
    } catch (err) {
      if (gen === generation.current) setError(err instanceof Error ? err.message : 'Could not load messages')
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [conversationId, from])

  const loadMore = useCallback(async () => {
    if (!conversationId || !from || !hasMore || loadingMore) return
    // Newest first, so the last row is the oldest one on the page.
    const oldest = messages[messages.length - 1]
    if (!oldest) return
    const gen = generation.current
    setLoadingMore(true)
    try {
      const page = await api.messages(conversationId, { from, beforeSeq: oldest.seq, limit: PAGE_SIZE })
      if (gen !== generation.current) return
      setMessages((prev) => [...prev, ...page.messages.filter((m) => !prev.some((p) => p.id === m.id))])
      setHasMore(page.hasMore)
    } catch (err) {
      if (gen === generation.current) setError(err instanceof Error ? err.message : 'Could not load messages')
    } finally {
      setLoadingMore(false)
    }
  }, [conversationId, from, hasMore, loadingMore, messages])

  useEffect(() => {
    setMessages([])
    setHasMore(false)
    void reload()
  }, [reload])

  useTeamChatEvents(workspaceId, (event) => {
    if (!conversationId || !from) return
    if (event.type === 'ready') return void reload()
    if (event.type !== 'message.created' && event.type !== 'message.updated') return
    if (event.conversationId !== conversationId) return
    // A message by someone else only matters if it is already on the list (an
    // edit or a delete of one of this member's rows).
    if (!isFromMember(event.message, from) && !messages.some((m) => m.id === event.message.id)) return
    void reload()
  })

  return { messages, loading, loadingMore, error, hasMore, loadMore, reload }
}
