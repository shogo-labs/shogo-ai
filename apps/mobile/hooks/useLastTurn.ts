// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Loads a chat's recent messages and boils the newest turn down for a peek. */
import { useEffect, useState } from 'react'
import { useChatMessageCollectionForSession } from '@shogo/shared-app/domain'
import { summarizeLastTurn, type LastTurn, type TurnMessage } from '../lib/last-turn'

const PAGE_SIZE = 50

function toTurnMessages(records: any[]): TurnMessage[] {
  return [...records]
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((record) => {
      let parts: unknown[] | undefined
      if (record.parts) {
        try {
          const parsed = JSON.parse(record.parts)
          parts = Array.isArray(parsed) ? parsed : undefined
        } catch {
          parts = undefined
        }
      }
      return { id: record.id, role: record.role, parts: parts ?? [{ type: 'text', text: record.content ?? '' }] }
    })
}

export function useLastTurn(chatSessionId: string | null | undefined, enabled: boolean) {
  const collection = useChatMessageCollectionForSession(chatSessionId ?? '')
  const [turn, setTurn] = useState<LastTurn | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !chatSessionId || !collection) {
      setTurn(null)
      return
    }
    let live = true
    setLoading(true)
    setError(null)
    collection
      .loadPage({ sessionId: chatSessionId, agent: 'technical' }, { limit: PAGE_SIZE, offset: 0 })
      .then(() => {
        if (live) setTurn(summarizeLastTurn(toTurnMessages(collection.all as any[])))
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : 'Could not load this chat'))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [enabled, chatSessionId, collection])

  return { turn, loading, error }
}
