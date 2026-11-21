// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fetch and cache the detail for one running chat turn, used by RunPeekHover
 * when the pointer enters a Running now row on web/desktop.
 *
 * - Opens only while the card is visible (open = true).
 * - Caches per chatSessionId:turnId for 10 s to avoid re-fetching when the
 *   pointer briefly leaves and re-enters the row.
 * - Refreshes every 5 s while open (reply text updates as the agent streams).
 * - Closes cleanly when the peek returns null (turn ended mid-hover).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDomainHttp } from '../contexts/domain'
import { api, type ActiveChatPeek } from '../lib/api'

const REFRESH_MS = 5_000
const CACHE_TTL_MS = 10_000

type CacheEntry = { peek: ActiveChatPeek | null; expiresAt: number }
const cache = new Map<string, CacheEntry>()

function cacheKey(chatSessionId: string, turnId: string) {
  return `${chatSessionId}:${turnId}`
}

export type PeekState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; peek: ActiveChatPeek }
  | { status: 'hidden' }
  | { status: 'done' }
  | { status: 'error'; message: string }

export function useRunPeek(opts: {
  open: boolean
  workspaceId: string | null | undefined
  chatSessionId: string | undefined
  turnId: string | undefined
  onDone?: () => void
}): PeekState {
  const { open, workspaceId, chatSessionId, turnId, onDone } = opts
  const http = useDomainHttp()
  const [state, setState] = useState<PeekState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Callers pass an inline arrow; reading it through a ref keeps `fetchPeek`
  // (and the effect below) stable, or every render would restart the fetch,
  // set `loading` and render again — React's "Maximum update depth exceeded".
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const fetchPeek = useCallback(
    async (signal: AbortSignal, initial: boolean) => {
      if (!workspaceId || !chatSessionId || !turnId) return
      const key = cacheKey(chatSessionId, turnId)
      const now = Date.now()
      const cached = cache.get(key)
      if (cached && cached.expiresAt > now) {
        if (cached.peek === null) {
          setState({ status: 'done' })
          onDoneRef.current?.()
        } else if (cached.peek.hidden) {
          setState({ status: 'hidden' })
        } else {
          setState({ status: 'ready', peek: cached.peek })
        }
        return
      }
      if (initial) setState({ status: 'loading' })
      try {
        const peek = await api.getActiveChatPeek(http, workspaceId, chatSessionId)
        if (signal.aborted) return
        cache.set(key, { peek, expiresAt: Date.now() + CACHE_TTL_MS })
        if (peek === null) {
          setState({ status: 'done' })
          onDoneRef.current?.()
        } else if (peek.hidden) {
          setState({ status: 'hidden' })
        } else {
          setState({ status: 'ready', peek })
        }
      } catch (err) {
        if (signal.aborted) return
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load' })
      }
    },
    [workspaceId, chatSessionId, turnId, http],
  )

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      setState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    void fetchPeek(controller.signal, true)
    timerRef.current = setInterval(() => {
      void fetchPeek(controller.signal, false)
    }, REFRESH_MS)
    return () => {
      controller.abort()
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open, fetchPeek])

  return state
}
