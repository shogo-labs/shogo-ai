// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat tags in a message body (SHO-52).
 *
 * The wire form is `<@c:CHAT_ID>`; readers see `@Chat title` as a chip that
 * opens that chat. Titles (and the owning workspace) are not in the message,
 * so they come from `lib/chat-mention-meta`. The source chip also shows
 * delivery state — queued, working, replied — polled from
 * `/api/chat-mention-status`, so nobody has to refresh to know the handoff
 * landed.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Pressable, Text, type StyleProp, type TextStyle } from "react-native"
import { useRouter } from "expo-router"
import { useProjectCollection } from "../../contexts/domain"
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace"
import { openInWorkspace } from "../../lib/switch-workspace"
import { workspaceHttp } from "../../lib/workspace-http"
import { chatIdsIn } from "../../lib/chat-mention-text"
import {
  getChatMentionMeta,
  requestChatMentionMeta,
  subscribeChatMentionMeta,
  type ChatMentionMeta,
} from "../../lib/chat-mention-meta"

export type { ChatMentionMeta }

/**
 * Where a chip opens. Workspace-agent chats belong to the workspace agent,
 * project chats to the project surface — and both carry the session id, so the
 * screen lands on the conversation rather than the workspace's current one.
 *
 * The workspace itself is deliberately not in the href: a chat in another
 * workspace is opened by having the chat screen adopt the workspace that owns
 * the session it loaded (`adoptChatWorkspace`). A `?workspace=` param
 * cannot do it — the boot's redirect-to-home bounce replaces the URL before
 * anything reads it.
 */
export function chatMentionHref(meta: {
  id: string
  projectId?: string | null
  workspaceId?: string
}): string {
  const base = meta.projectId ? `/(app)/projects/${meta.projectId}` : "/(app)/agent"
  return `${base}?chatSessionId=${encodeURIComponent(meta.id)}`
}

interface ChatMentionStatus {
  queued: number
  working: boolean
  /** Set once the message is persisted in the target chat — survives a failed turn. */
  deliveredAt?: string | null
  repliedAt: string | null
}

const CHAT_TOKEN_RE = /<@c:([A-Za-z0-9_-]+)>/g
const STATUS_POLL_MS = 5000

/** Titles for the chat ids in `ids`, fetched once and shared across messages. */
export function useChatMentionMeta(ids: string[]): Record<string, ChatMentionMeta> {
  const key = ids.join(",")
  const [version, bump] = useState(0)
  useEffect(() => subscribeChatMentionMeta(() => bump((n) => n + 1)), [])
  useEffect(() => {
    for (const id of ids) requestChatMentionMeta(id)
    // `key` captures the id list; `ids` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useMemo(() => {
    const out: Record<string, ChatMentionMeta> = {}
    for (const id of ids) {
      const meta = getChatMentionMeta(id)
      if (meta) out[id] = meta
    }
    return out
    // `version` changes whenever the shared cache fills in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
}

/**
 * Delivery state of the chats tagged in one message. Only polled for messages
 * the user sent (`since` = when it was sent); stops once every chat replied.
 */
function useChatMentionStatus(ids: string[], since?: string | number | Date | null) {
  const [statuses, setStatuses] = useState<Record<string, ChatMentionStatus>>({})
  const sinceIso = useMemo(() => {
    if (!since) return null
    const date = since instanceof Date ? since : new Date(since)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }, [since])
  const key = ids.join(",")

  useEffect(() => {
    if (!sinceIso || !key) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const { data } = await workspaceHttp().get<{ statuses?: Record<string, ChatMentionStatus> }>(
          "/api/chat-mention-status",
          { ids: key, since: sinceIso },
        )
        if (cancelled) return
        const next = (data?.statuses ?? {}) as Record<string, ChatMentionStatus>
        setStatuses(next)
        const settled = ids.every((id) => next[id]?.repliedAt)
        if (!settled) timer = setTimeout(poll, STATUS_POLL_MS)
      } catch {
        if (!cancelled) timer = setTimeout(poll, STATUS_POLL_MS * 3)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sinceIso])

  return statuses
}

function statusLabel(status?: ChatMentionStatus): string | null {
  if (!status) return null
  if (status.repliedAt) {
    const date = new Date(status.repliedAt)
    return Number.isNaN(date.getTime())
      ? "replied"
      : `replied ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
  }
  if (status.working) return "working"
  // Durable: the message is in the target chat even if its turn never answers.
  // Without it a failed turn makes the tag look like it did nothing.
  if (status.deliveredAt) return "delivered"
  if (status.queued > 0) return "queued"
  return null
}

/** One chat chip: title from the cache, press opens the chat. */
export function ChatMentionChip({
  id,
  meta,
  status,
  inverted = false,
}: {
  id: string
  meta?: ChatMentionMeta
  status?: ChatMentionStatus
  inverted?: boolean
}) {
  const router = useRouter()
  const projects = useProjectCollection()
  const activeWorkspace = useActiveWorkspace() as { id?: string } | null
  const label = meta?.title ?? `chat ${id.slice(0, 8)}`
  const state = statusLabel(status)
  const open = useCallback(() => {
    // A chat tagged from another workspace must switch to it first: the chat
    // screens read the active workspace, and sending from the wrong one is
    // rejected server-side (`session_not_in_workspace`).
    openInWorkspace(
      router,
      meta?.workspaceId,
      chatMentionHref({ id, projectId: meta?.projectId ?? null, workspaceId: meta?.workspaceId }),
      activeWorkspace?.id,
      projects,
    )
  }, [router, id, meta?.projectId, meta?.workspaceId, activeWorkspace?.id, projects])

  return (
    <Text
      onPress={open}
      suppressHighlighting
      className={
        inverted
          ? "text-[13px] font-medium text-sky-100 underline"
          : "text-[13px] font-medium text-sky-600 underline dark:text-sky-300"
      }
    >
      @{label}
      {state ? <Text className="text-[11px] opacity-70">{` · ${state}`}</Text> : null}
    </Text>
  )
}

/**
 * The point in time a message's tags are measured from: when the person sent it.
 *
 * Keyed on the role, not on the bubble variant: the newest user message is
 * painted by `EditableUserMessage`, which is not the `userBubble` variant, and a
 * null window there is what left a fresh tag with no delivery state at all.
 */
export function chatMentionSince(message: {
  role?: string | null
  createdAt?: string | number | Date | null
}): string | number | Date | null {
  if (message?.role !== "user") return null
  return message.createdAt ?? null
}

/**
 * A message body with its `<@c:ID>` tokens rendered as chips. Everything else
 * is plain text (user messages are not markdown).
 */
export function ChatMentionText({
  text,
  since,
  className,
  style,
  selectable,
  inverted = false,
}: {
  text: string
  since?: string | number | Date | null
  className?: string
  style?: StyleProp<TextStyle>
  selectable?: boolean
  inverted?: boolean
}) {
  const ids = useMemo(() => chatIdsIn(text), [text])
  const metas = useChatMentionMeta(ids)
  const statuses = useChatMentionStatus(ids, since)

  const segments = useMemo(() => {
    const out: Array<{ kind: "text"; value: string } | { kind: "chat"; id: string }> = []
    let last = 0
    for (const match of text.matchAll(CHAT_TOKEN_RE)) {
      const index = match.index ?? 0
      if (index > last) out.push({ kind: "text", value: text.slice(last, index) })
      out.push({ kind: "chat", id: match[1] })
      last = index + match[0].length
    }
    if (last < text.length) out.push({ kind: "text", value: text.slice(last) })
    return out
  }, [text])

  return (
    <Text className={className} style={style} selectable={selectable}>
      {segments.map((segment, index) =>
        segment.kind === "chat" ? (
          <ChatMentionChip
            key={`chat-${segment.id}-${index}`}
            id={segment.id}
            meta={metas[segment.id]}
            status={statuses[segment.id]}
            inverted={inverted}
          />
        ) : (
          <Text key={`text-${index}`}>{segment.value}</Text>
        ),
      )}
    </Text>
  )
}
