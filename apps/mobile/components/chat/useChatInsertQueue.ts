// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import { returnChatInserts, subscribeChatInsert, type ChatInsertRequest } from "../../lib/chat-insert-bus"
import type { ChatInsertComposerRequest } from "./ChatInput"

interface QueuedInsert {
  composer: ChatInsertComposerRequest
  source: ChatInsertRequest
}

/**
 * Feeds "Add to Chat" requests (IDE tree/editor, terminal ⌘L, Shogo Code —
 * see lib/chat-insert-bus.ts) to the active panel's composer, one at a time.
 * Requests queue here while the composer is unmounted (collapsed chat), and
 * `expand` is called so it mounts and shows them. When the panel stops being
 * active, unapplied requests go back to the bus for the next active panel.
 */
export function useChatInsertQueue({ isActive, expand }: { isActive: boolean; expand: () => void }) {
  const [queue, setQueue] = useState<QueuedInsert[]>([])
  const queueRef = useRef<QueuedInsert[]>([])
  const nonceRef = useRef(0)
  const expandRef = useRef(expand)
  expandRef.current = expand

  const updateQueue = useCallback((next: (current: QueuedInsert[]) => QueuedInsert[]) => {
    queueRef.current = next(queueRef.current)
    setQueue(queueRef.current)
  }, [])

  useEffect(() => {
    if (Platform.OS !== "web" || !isActive) return
    const unsubscribe = subscribeChatInsert((request) => {
      if (!request.references?.length && !request.text?.trim()) {
        request.onApplied?.()
        return
      }
      expandRef.current()
      updateQueue((current) => [
        ...current,
        { composer: { nonce: ++nonceRef.current, references: request.references, text: request.text }, source: request },
      ])
    })
    return () => {
      unsubscribe()
      const pending = queueRef.current
      if (pending.length === 0) return
      updateQueue(() => [])
      returnChatInserts(pending.map((item) => item.source))
    }
  }, [isActive, updateQueue])

  const markApplied = useCallback((nonce: number) => {
    const applied = queueRef.current.find((item) => item.composer.nonce === nonce)
    updateQueue((current) => current.filter((item) => item.composer.nonce !== nonce))
    applied?.source.onApplied?.()
  }, [updateQueue])

  return { insertRequest: isActive ? (queue[0]?.composer ?? null) : null, markApplied }
}
