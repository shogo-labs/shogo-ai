// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Files shared in one conversation, newest first, with name search, a kind
 * filter and cursor paging. Refetches when a message with files lands or a
 * message is deleted.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { teamChatApi, type ConversationFile, type ConversationFileKind } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'

const api = teamChatApi()
const PAGE_SIZE = 50

export interface UseConversationFilesOptions {
  q?: string
  kind?: ConversationFileKind
}

export function useConversationFiles(workspaceId: string | null, conversationId: string | null, opts: UseConversationFilesOptions = {}) {
  const [files, setFiles] = useState<ConversationFile[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const q = opts.q?.trim() || undefined
  const kind = opts.kind

  const reload = useCallback(async () => {
    if (!conversationId) return
    const gen = ++generation.current
    setLoading(true)
    try {
      const page = await api.files(conversationId, { q, kind, limit: PAGE_SIZE })
      if (gen !== generation.current) return
      setFiles(page.files)
      setNextCursor(page.nextCursor)
      setError(null)
    } catch (err) {
      if (gen === generation.current) setError(err instanceof Error ? err.message : 'Could not load files')
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [conversationId, q, kind])

  const loadMore = useCallback(async () => {
    if (!conversationId || !nextCursor || loadingMore) return
    const gen = generation.current
    setLoadingMore(true)
    try {
      const page = await api.files(conversationId, { q, kind, cursor: nextCursor, limit: PAGE_SIZE })
      if (gen !== generation.current) return
      setFiles((prev) => [...prev, ...page.files.filter((f) => !prev.some((p) => p.id === f.id))])
      setNextCursor(page.nextCursor)
    } catch (err) {
      if (gen === generation.current) setError(err instanceof Error ? err.message : 'Could not load files')
    } finally {
      setLoadingMore(false)
    }
  }, [conversationId, nextCursor, loadingMore, q, kind])

  useEffect(() => {
    setFiles([])
    setNextCursor(null)
    void reload()
  }, [reload])

  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'ready') return void reload()
    if (event.type === 'message.created' && event.conversationId === conversationId && event.message.attachments?.length) {
      void reload()
    }
    if (event.type === 'message.updated' && event.conversationId === conversationId && event.message.deletedAt) {
      if (files.some((f) => f.messageId === event.message.id)) void reload()
    }
  })

  return { files, loading, loadingMore, error, hasMore: !!nextCursor, loadMore, reload }
}
