// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who a tagged chat is: its title and the workspace that owns it (SHO-52).
 *
 * Message bodies carry only `<@c:CHAT_ID>` — a rename must not rewrite history
 * — so titles come from `GET /api/chat-mentionables` and are cached for the
 * session. The same answer says which workspace the chat lives in, which is
 * what lets a deep link (`/agent?chatSessionId=…`) open a chat the app is not
 * currently in: the screen asks here, then adopts the workspace.
 */

import { Platform } from "react-native"
import { API_URL } from "./api-url"
import { authClient } from "./auth-client"

export interface ChatMentionMeta {
  id: string
  title: string
  projectId?: string | null
  workspaceId?: string
  workspaceName?: string
}

const cache = new Map<string, ChatMentionMeta>()
const listeners = new Set<() => void>()
const pendingIds = new Set<string>()
let pendingTimer: ReturnType<typeof setTimeout> | null = null

export function subscribeChatMentionMeta(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getChatMentionMeta(id: string): ChatMentionMeta | undefined {
  return cache.get(id)
}

export function chatMentionCacheSize(): number {
  return cache.size
}

function notifyMeta(): void {
  for (const listener of [...listeners]) listener()
}

export function chatMentionAuthHeaders(): Record<string, string> {
  if (Platform.OS === "web") return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

async function fetchMetas(ids: string[]): Promise<void> {
  const params = new URLSearchParams({ ids: ids.join(","), limit: String(ids.length) })
  const response = await fetch(`${API_URL}/api/chat-mentionables?${params}`, {
    headers: chatMentionAuthHeaders(),
    credentials: Platform.OS === "web" ? "include" : undefined,
  } as any)
  if (!response.ok) return
  const data = await response.json().catch(() => null)
  for (const chat of Array.isArray(data?.chats) ? data.chats : []) {
    cache.set(chat.id, {
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      workspaceId: chat.workspaceId,
      workspaceName: chat.workspaceName,
    })
  }
  // A chat that came back without a row (deleted, no longer readable) still
  // needs a label, so the chip is not a bare id.
  for (const id of ids) {
    if (!cache.has(id)) cache.set(id, { id, title: `chat ${id.slice(0, 8)}` })
  }
  notifyMeta()
}

/** The chat's title and owning workspace, awaited. Null when it cannot be read. */
export async function chatMentionMetaFor(id: string): Promise<ChatMentionMeta | null> {
  const known = cache.get(id)
  if (known?.workspaceId) return known
  try {
    await fetchMetas([id])
  } catch {
    return known ?? null
  }
  return cache.get(id) ?? null
}

/** Queue a title lookup, coalescing every id requested in the same tick. */
export function requestChatMentionMeta(id: string): void {
  if (cache.has(id) || pendingIds.has(id)) return
  pendingIds.add(id)
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    const ids = [...pendingIds]
    pendingIds.clear()
    pendingTimer = null
    void fetchMetas(ids).catch(() => {
      // Cache the misses, so a deleted chat does not refetch forever.
      for (const missing of ids) {
        if (!cache.has(missing)) {
          cache.set(missing, { id: missing, title: `chat ${missing.slice(0, 8)}` })
        }
      }
      notifyMeta()
    })
  }, 50)
}
