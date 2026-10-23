// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Boards for a channel, one board's columns and cards, and one card's detail.
 * Each reloads on `board.changed` for what it shows, so moves by agents and
 * teammates appear without a refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTeamChatEvents } from '../lib/team-chat-connection'
import { workBoardsApi, type Board, type BoardView, type WorkItemDetail } from '../lib/work-boards-api'
import { applyAgentMessage } from '../lib/board-layout'

const api = workBoardsApi()

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/** Coalesce bursts of events (a bulk move fires one per card) into one reload. */
function useDebounced(fn: () => void, ms = 150): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => fnRef.current(), ms)
  }, [ms])
}

export function useChannelBoards(workspaceId: string | null | undefined, conversationId: string | null | undefined, enabled = true) {
  const [boards, setBoards] = useState<Board[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!workspaceId || !conversationId || !enabled) return
    setLoading(true)
    try {
      setBoards(await api.list(workspaceId, { conversationId }))
      setError(null)
    } catch (err) {
      setError(message(err, 'Could not load boards'))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, conversationId, enabled])

  useEffect(() => {
    setBoards([])
    void reload()
  }, [reload])

  const soon = useDebounced(() => void reload())
  useTeamChatEvents(enabled ? workspaceId : null, (event) => {
    if (event.type === 'ready') return soon()
    if (event.type !== 'board.changed' || !event.action.startsWith('board.')) return
    if (event.conversationId === conversationId || boards.some((b) => b.id === event.boardId)) soon()
  })

  return { boards, loading, error, reload, setBoards }
}

export function useBoardView(boardId: string | null | undefined, workspaceId: string | null | undefined, q = '') {
  const [view, setView] = useState<BoardView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const reload = useCallback(async () => {
    if (!boardId) return
    const ticket = ++latest.current
    try {
      const next = await api.view(boardId, { q: q.trim() || undefined })
      if (ticket !== latest.current) return
      setView(next)
      setError(null)
    } catch (err) {
      if (ticket === latest.current) setError(message(err, 'Could not load this board'))
    }
  }, [boardId, q])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    setView(null)
  }, [boardId])

  const soon = useDebounced(() => void reload())
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'ready') return soon()
    if (event.type === 'board.changed' && event.boardId === boardId) soon()
    // Agent replies start and settle in a card's thread: show the spinner without a reload.
    if (event.type === 'message.created' || event.type === 'message.updated') {
      const message = event.message
      setView((v) => (v && applyAgentMessage(v, message)) || v)
    }
  })

  return { view, error, reload, setView }
}

export function useWorkItem(itemId: string | null | undefined, workspaceId: string | null | undefined) {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!itemId) return
    try {
      setDetail(await api.get(itemId))
      setError(null)
    } catch (err) {
      setError(message(err, 'Could not load this card'))
    }
  }, [itemId])

  useEffect(() => {
    setDetail(null)
    setError(null)
    void reload()
  }, [reload])

  const soon = useDebounced(() => void reload())
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type !== 'board.changed' || !itemId) return
    if (event.itemId === itemId || (!event.itemId && event.boardId === detail?.board.id)) soon()
  })

  return { detail, error, reload, setDetail }
}
