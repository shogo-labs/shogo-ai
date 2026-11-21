// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The user's most recently active agent chats (workspace + project agents),
 * one per agent at most. Fetched on mount and on app-foreground; re-fetched
 * when `refreshKey` changes (pass a counter that increments when
 * useWorkspaceChats reports a new or updated session).
 *
 * Returns `{ chats, loading }`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useDomainHttp } from '../contexts/domain'
import { useWorkspaceInView } from './useWorkspaceInView'
import { api, type RecentAgentChat } from '../lib/api'

export function useRecentAgentChats(opts: { limit?: number; perAgent?: boolean; refreshKey?: number } = {}) {
  const http = useDomainHttp()
  const workspace = useWorkspaceInView()
  const [chats, setChats] = useState<RecentAgentChat[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetch = useCallback(async () => {
    const workspaceId = workspace?.id
    if (!workspaceId) return
    try {
      const result = await api.listRecentAgentChats(http, workspaceId, {
        limit: opts.limit ?? 5,
        perAgent: opts.perAgent ?? true,
      })
      if (mountedRef.current) setChats(result)
    } catch {
      // non-fatal: keep the previous list
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [http, workspace?.id, opts.limit, opts.perAgent])

  // Refetch on focus.
  useFocusEffect(useCallback(() => { void fetch() }, [fetch]))

  // Refetch when the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void fetch()
    })
    return () => sub.remove()
  }, [fetch])

  // Refetch when the caller says something changed (e.g. a new chat was started).
  useEffect(() => {
    if (opts.refreshKey !== undefined) void fetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.refreshKey])

  return { chats, loading }
}
