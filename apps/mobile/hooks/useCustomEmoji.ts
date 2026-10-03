// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace's custom emoji, kept current over the realtime connection.
 * Custom emoji travel as `:name:` in reactions and message text.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { absoluteApiUrl, teamChatApi, type CustomEmoji } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'

const api = teamChatApi()
const store = new Map<string, Map<string, CustomEmoji>>()
const listeners = new Set<() => void>()
let version = 0
let feedWorkspaceId: string | null = null

const EMOJI_CODE_RE = /^:([a-z0-9_+-]{2,32}):$/

function load(workspaceId: string) {
  api.emoji(workspaceId)
    .then((list) => {
      store.set(workspaceId, new Map(list.map((e) => [e.name, { ...e, url: absoluteApiUrl(e.url) }])))
      version++
      listeners.forEach((l) => l())
    })
    .catch(() => {})
}

export function useCustomEmojiFeed(workspaceId: string | null | undefined): void {
  useEffect(() => {
    if (!workspaceId) return
    feedWorkspaceId = workspaceId
    if (!store.has(workspaceId)) load(workspaceId)
  }, [workspaceId])
  useTeamChatEvents(workspaceId, (event) => {
    if (workspaceId && event.type === 'emoji.changed') load(workspaceId)
  })
}

export function useCustomEmoji(workspaceId?: string | null): Map<string, CustomEmoji> {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
    () => version,
  )
  const ws = workspaceId ?? feedWorkspaceId
  return (ws && store.get(ws)) || EMPTY
}

const EMPTY = new Map<string, CustomEmoji>()

/** The custom emoji for a `:name:` code, if the workspace has one. */
export function customEmojiFor(code: string, emoji: Map<string, CustomEmoji>): CustomEmoji | null {
  const m = EMOJI_CODE_RE.exec(code)
  return m ? emoji.get(m[1]) ?? null : null
}

/** A message that's only custom/unicode emoji (up to 6) renders large. */
export function jumboEmojiCodes(text: string, emoji: Map<string, CustomEmoji>): string[] | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 200) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length > 6) return null
  return parts.every((p) => customEmojiFor(p, emoji)) ? parts : null
}
