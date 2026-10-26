// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent questions in this workspace, for the Questions inbox and the badges
 * that point to it. Polls while the app is in front, and drops a question the
 * moment it is answered or dismissed from anywhere in the app.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { subscribeQuestionClosed } from '../lib/question-answer'
import { teamChatApi, type PendingApproval, type QuestionListItem } from '../lib/team-chat-api'

const POLL_MS = 15_000
const api = teamChatApi()

export type QuestionTab = 'open' | 'answered' | 'all'

export function useOpenQuestions(
  workspaceId: string | null | undefined,
  opts: { status?: QuestionTab; scope?: 'mine' | 'all'; polling?: boolean; enabled?: boolean } = {},
) {
  const { status = 'open', scope = 'mine', polling = true, enabled = true } = opts
  const [questions, setQuestions] = useState<QuestionListItem[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (!workspaceId || !enabled || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const result = await api.questions(workspaceId, { status, scope })
      setQuestions(result.questions)
      setApprovals(result.approvals)
      setOpenCount(result.openCount)
      setError(null)
    } catch (err: any) {
      setError(err?.response?.data?.error?.message ?? 'Could not load questions')
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [workspaceId, enabled, status, scope])

  useEffect(() => {
    setQuestions([])
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!polling || !workspaceId || !enabled) return
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [polling, workspaceId, enabled, refresh])

  useEffect(
    () =>
      subscribeQuestionClosed(({ messageId, questionId }) => {
        if (status === 'open') setQuestions((current) => current.filter((q) => !(q.messageId === messageId && q.question.id === questionId)))
        void refresh()
      }),
    [refresh, status],
  )

  return { questions, approvals, openCount, loading, error, refresh }
}

const COUNT_POLL_MS = 30_000
const counts = new Map<string, { value: number; listeners: Set<(n: number) => void>; timer: ReturnType<typeof setInterval> | null }>()

async function loadCount(workspaceId: string): Promise<void> {
  const entry = counts.get(workspaceId)
  if (!entry) return
  try {
    const result = await api.questions(workspaceId, { status: 'open', scope: 'mine' })
    entry.value = result.openCount
    for (const listener of entry.listeners) listener(entry.value)
  } catch {
    // Keep the last count; the next poll tries again.
  }
}

/** Open questions for the viewer, for badges. One poll per workspace however many badges show it. */
export function useOpenQuestionCount(workspaceId: string | null | undefined): number {
  const [count, setCount] = useState(() => (workspaceId ? counts.get(workspaceId)?.value ?? 0 : 0))
  useEffect(() => {
    if (!workspaceId) {
      setCount(0)
      return
    }
    let entry = counts.get(workspaceId)
    if (!entry) {
      entry = { value: 0, listeners: new Set(), timer: null }
      counts.set(workspaceId, entry)
    }
    entry.listeners.add(setCount)
    setCount(entry.value)
    if (!entry.timer) {
      void loadCount(workspaceId)
      entry.timer = setInterval(() => {
        if (AppState.currentState === 'active') void loadCount(workspaceId)
      }, COUNT_POLL_MS)
    }
    const unsubscribe = subscribeQuestionClosed(() => void loadCount(workspaceId))
    return () => {
      unsubscribe()
      entry!.listeners.delete(setCount)
      if (!entry!.listeners.size && entry!.timer) {
        clearInterval(entry!.timer)
        entry!.timer = null
      }
    }
  }, [workspaceId])
  return count
}
