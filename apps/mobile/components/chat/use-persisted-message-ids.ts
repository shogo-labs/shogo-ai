// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Adopt persisted `ChatMessage.id`s into the live transcript (SHO-263).
 *
 * `useChat` stamps the messages it creates with its own nanoid, while the row
 * `/api/chat-messages` persisted for them has a cuid. Everything the edit/retry
 * UX calls addresses the ROW (`truncate-from`, `preceding-checkpoint`,
 * feedback), so a message sent in the current page session used to 404 and the
 * edit silently rolled back. Swapping in the row id as soon as the create call
 * resolves keeps the bubble and the row in agreement for the rest of the
 * session.
 */
import { useCallback, useEffect, useRef } from "react"
import type { UIMessage } from "ai"
import { planIdAdoptions, type PendingIdAdoption } from "./persisted-message-ids"

type SetMessages = (updater: (prev: UIMessage[]) => UIMessage[]) => void

/**
 * Called for each swap once the transcript carries the row id. Anything the
 * panel tracks *by message id* (the open editor, its pending draft, the
 * "Files reverted…" note) has to move with it.
 */
export type OnIdAdopted = (from: string, to: string) => void

export interface PersistedMessageIds {
  /** Call with the row id the create call returned, plus the text that was sent. */
  adopt: (rowId: string, text: string) => void
  /** Adoptions still waiting for their bubble to appear (tests/diagnostics). */
  pendingCount: () => number
}

export function usePersistedMessageIds(
  messages: UIMessage[],
  setMessages: SetMessages,
  onIdAdopted?: OnIdAdopted,
): PersistedMessageIds {
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // The callback is re-created on most ChatPanel renders; keep the latest in a
  // ref so the adopt/apply callbacks stay stable.
  const onIdAdoptedRef = useRef<OnIdAdopted | undefined>(onIdAdopted)
  onIdAdoptedRef.current = onIdAdopted

  const pendingRef = useRef<PendingIdAdoption[]>([])
  const adoptedRef = useRef<Set<string>>(new Set())

  const apply = useCallback(() => {
    if (pendingRef.current.length === 0) return
    const plan = planIdAdoptions(
      messagesRef.current,
      pendingRef.current,
      adoptedRef.current,
    )
    pendingRef.current = plan.remaining
    if (plan.swaps.length === 0) return
    for (const swap of plan.swaps) adoptedRef.current.add(swap.to)
    setMessages((prev) =>
      prev.map((message) => {
        const swap = plan.swaps.find((entry) => entry.from === message.id)
        return swap ? { ...message, id: swap.to } : message
      }),
    )
    for (const swap of plan.swaps) onIdAdoptedRef.current?.(swap.from, swap.to)
  }, [setMessages])

  const adopt = useCallback(
    (rowId: string, text: string) => {
      if (!rowId) return
      pendingRef.current = [...pendingRef.current, { rowId, text }]
      // The bubble is usually already on screen (a send appends it
      // synchronously); when it isn't, the effect finishes the job.
      apply()
    },
    [apply],
  )

  useEffect(() => {
    if (pendingRef.current.length === 0) return
    apply()
  }, [messages, apply])

  return { adopt, pendingCount: () => pendingRef.current.length }
}
