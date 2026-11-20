// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One member's messages in a conversation — top-level posts and thread replies
 * — newest first, paged backwards (SHO-419). Keeps loaded pages on realtime
 * events instead of reloading the first page (SHO-458).
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
      setMessages((prev) => {
        // Merge: keep any older pages already loaded beyond the first page.
        const oldestSeqInPage = page.messages[page.messages.length - 1]?.seq ?? 0
        const olderPages = prev.filter(
          (m) => m.seq < oldestSeqInPage && !page.messages.some((p) => p.id === m.id),
        )
        return [...page.messages, ...olderPages]
      })
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
    if (event.conversationId !== conversationId) return
    if (event.type === 'ready') {
      void reload()
      return
    }
    if (event.type === 'message.created') {
      if (!isFromMember(event.message, from)) return
      setMessages((prev) => {
        if (prev.some((m) => m.id === event.message.id)) return prev
        // Insert newest-first: new messages go to the front.
        return [event.message, ...prev]
      })
      return
    }
    if (event.type === 'message.updated') {
      setMessages((prev) => {
        if (!prev.some((m) => m.id === event.message.id)) return prev
        return prev.map((m) => (m.id === event.message.id ? event.message : m))
      })
    }
  })

  return { messages, loading, loadingMore, error, hasMore, loadMore, reload }
}
