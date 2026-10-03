// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace's team chat mode (off / native / external / bridged), shared
 * across the sidebar and settings so a change applies everywhere at once.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  teamChatApi,
  type ChatModeValue,
  type ExternalChatProvider,
  type WorkspaceChatMode,
} from '../lib/team-chat-api'

const api = teamChatApi()
const TTL_MS = 60_000

const store = new Map<string, { at: number; value: WorkspaceChatMode }>()
const inflight = new Map<string, Promise<WorkspaceChatMode>>()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function load(workspaceId: string): Promise<WorkspaceChatMode> {
  const existing = inflight.get(workspaceId)
  if (existing) return existing
  const p = api.chatMode(workspaceId)
    .then((value) => {
      store.set(workspaceId, { at: Date.now(), value })
      emit()
      return value
    })
    .finally(() => inflight.delete(workspaceId))
  inflight.set(workspaceId, p)
  return p
}

export function useWorkspaceChatMode(workspaceId: string | null | undefined) {
  const entry = useSyncExternalStore(
    subscribe,
    () => (workspaceId ? store.get(workspaceId) : undefined),
    () => undefined,
  )
  useEffect(() => {
    if (!workspaceId) return
    const hit = store.get(workspaceId)
    if (hit && Date.now() - hit.at < TTL_MS) return
    void load(workspaceId).catch(() => {})
  }, [workspaceId])

  const update = useCallback(
    async (mode: ChatModeValue, provider: ExternalChatProvider | null = null) => {
      if (!workspaceId) return null
      const value = await api.setChatMode(workspaceId, { mode, provider })
      store.set(workspaceId, { at: Date.now(), value })
      emit()
      return value
    },
    [workspaceId],
  )

  const refresh = useCallback(async () => {
    if (!workspaceId) return null
    store.delete(workspaceId)
    return load(workspaceId)
  }, [workspaceId])

  return { config: entry?.value ?? null, loading: !entry, update, refresh }
}
