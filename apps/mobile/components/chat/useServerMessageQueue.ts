// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef } from "react"
import { getEnv } from "mobx-state-tree"
import type { IChatQueuedMessage } from "@shogo/domain-stores"
import { useSDKDomains } from "@shogo/shared-app/domain"
import type { ChatReference, FileAttachment } from "./ChatInput"
import type { QueuedMessage } from "./ChatInput"
import type { UIMessage } from "ai"
import { queuedRowToUserMessage } from "./queued-user-message"

type QueueBody = Record<string, unknown> & { text?: string }

type UseServerMessageQueueOptions = {
  sessionId: string | null | undefined
  enabled: boolean
  isStreaming: boolean
  /**
   * Called when the server has taken the head of the queue and started its
   * turn. `userMessage` is the message it saved, so the window can show it.
   */
  onTurnAvailable?: (userMessage?: UIMessage) => void
}

/**
 * `collection.create` inserts the new row under a `temp-<uuid>` id and swaps it
 * for the server's row once the request returns. That swap makes the old id
 * disappear, which must not be read as the server taking the message off the
 * queue.
 */
const OPTIMISTIC_ID_PREFIX = "temp-"

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function filesFromParts(parts: string | undefined): FileAttachment[] | undefined {
  const parsed = parseJson<Array<Record<string, unknown>>>(parts, [])
  const files = parsed
    .filter((part) => part.type === "file" && typeof part.url === "string")
    .map((part) => {
      const file: FileAttachment = {
        dataUrl: String(part.url),
        type: String(part.mediaType || "application/octet-stream"),
        name: "",
      }
      if (typeof part.name === "string") file.name = part.name
      return file
    })
  return files.length > 0 ? files : undefined
}

function toQueuedMessage(row: IChatQueuedMessage): QueuedMessage {
  const body = parseJson<QueueBody>(row.body, {})
  return {
    id: row.id,
    content: row.content,
    files: filesFromParts(row.parts),
    selectedModel: typeof body.agentMode === "string" ? body.agentMode : undefined,
    references: Array.isArray(body.references)
      ? (body.references as ChatReference[])
      : undefined,
    status: row.status,
    error: row.error || undefined,
  }
}

export type ServerQueueEnqueueInput = {
  content: string
  files?: FileAttachment[]
  selectedModel?: string
  references?: ChatReference[]
  body: QueueBody
}

export function useServerMessageQueue({
  sessionId,
  enabled,
  isStreaming,
  onTurnAvailable,
}: UseServerMessageQueueOptions) {
  const { studioChat } = useSDKDomains()
  const collection = studioChat.chatQueuedMessageCollection
  const previousIdsRef = useRef<string[]>([])
  const previousRowsRef = useRef(new Map<string, IChatQueuedMessage>())
  const userRemovedIdsRef = useRef(new Set<string>())

  // `collection.all` mutates in place, so it must be read on every render for
  // the observer to see new rows; the signature keeps `rows` stable otherwise.
  const liveRows =
    enabled && sessionId
      ? collection.all
          .filter((row) => row.sessionId === sessionId)
          .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
      : []
  const rowsSignature = liveRows
    .map((row) => `${row.id}:${row.position}:${row.status}:${row.updatedAt}:${row.error ?? ""}:${row.content}`)
    .join("\n")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => liveRows, [rowsSignature])
  const queuedMessages = useMemo(() => rows.map(toQueuedMessage), [rows])

  useEffect(() => {
    previousIdsRef.current = []
    previousRowsRef.current = new Map()
  }, [sessionId])

  const load = useCallback(async () => {
    if (!enabled || !sessionId) return
    await collection.loadAll({ sessionId })
  }, [collection, enabled, sessionId])

  useEffect(() => {
    void load().catch((error) => {
      console.warn("[ChatQueue] Failed to load server queue:", error)
    })
  }, [load])

  useEffect(() => {
    if (!enabled || !sessionId || rows.length === 0 || isStreaming) return
    const timer = setInterval(() => {
      void load().catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [enabled, sessionId, rows.length, isStreaming, load])

  useEffect(() => {
    const previous = previousIdsRef.current
    const previousRows = previousRowsRef.current
    const current = rows.map((row) => row.id)
    previousRowsRef.current = new Map(rows.map((row) => [row.id, row]))
    const removedHead =
      previous.length > 0 &&
      !!previous[0] &&
      !previous[0].startsWith(OPTIMISTIC_ID_PREFIX) &&
      !current.includes(previous[0])
    previousIdsRef.current = current
    if (removedHead && previous[0] && userRemovedIdsRef.current.has(previous[0])) {
      userRemovedIdsRef.current.delete(previous[0])
      return
    }
    if (removedHead && onTurnAvailable) {
      const removed = previous[0] ? previousRows.get(previous[0]) : undefined
      onTurnAvailable(removed ? queuedRowToUserMessage(removed) : undefined)
    }
  }, [rows, onTurnAvailable])

  const enqueue = useCallback(
    async (input: ServerQueueEnqueueInput) => {
      if (!sessionId) throw new Error("No chat session selected")
      const parts = [
        ...(input.content.trim()
          ? [{ type: "text", text: input.content.trim() }]
          : []),
        ...(input.files || []).map((file) => ({
          type: "file",
          mediaType: file.type || "application/octet-stream",
          url: file.dataUrl,
          ...(file.name ? { name: file.name } : {}),
        })),
      ]
      const body = {
        ...input.body,
        text: input.body.text ?? input.content.trim(),
        references: input.references ?? input.body.references,
      }
      return collection.create({
        sessionId,
        userId: "",
        content: input.content.trim(),
        parts: JSON.stringify(parts),
        body: JSON.stringify(body),
      } as any)
    },
    [collection, sessionId],
  )

  const remove = useCallback(
    async (id: string) => {
      userRemovedIdsRef.current.add(id)
      try {
        await collection.delete(id)
      } catch (error) {
        userRemovedIdsRef.current.delete(id)
        throw error
      } finally {
        setTimeout(() => userRemovedIdsRef.current.delete(id), 0)
      }
    },
    [collection],
  )

  const update = useCallback(
    async (id: string, changes: Record<string, unknown>) => {
      await collection.update(id, changes as any)
    },
    [collection],
  )

  const action = useCallback(
    async (id: string, actionName: "reorder" | "send-now", body?: Record<string, unknown>) => {
      const env = getEnv<{ http: { post: (url: string, body?: unknown) => Promise<{ data?: any }> } }>(collection)
      const response = await env.http.post(
        `/api/chat-queued-messages/${encodeURIComponent(id)}/${actionName}`,
        body,
      )
      if (!response.data?.ok) {
        throw new Error(response.data?.error?.message || `Queue ${actionName} failed`)
      }
      await load()
      return response.data.data
    },
    [collection, load],
  )

  const reorder = useCallback(
    async (id: string, direction: "up" | "down") => {
      await action(id, "reorder", { direction })
    },
    [action],
  )

  const sendNow = useCallback(
    async (id: string) => {
      await action(id, "send-now")
    },
    [action],
  )

  const isServerQueued = useCallback(
    (id: string) => rows.some((row) => row.id === id),
    [rows],
  )

  // Memoized: ChatPanel lists this object as a dependency of many callbacks
  // (including `handleSendMessage`, which sits in the chat context). A fresh
  // object every render rebuilt all of them, and so re-rendered every message
  // in the history on each streamed token.
  return useMemo(
    () => ({
      queuedMessages,
      enqueue,
      remove,
      update,
      reorder,
      sendNow,
      isServerQueued,
      reload: load,
    }),
    [queuedMessages, enqueue, remove, update, reorder, sendNow, isServerQueued, load],
  )
}
