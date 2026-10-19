// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  const pendingTurnRef = useRef<{ userMessage?: UIMessage } | null>(null)
  /**
   * Rows this window enqueued, keyed by their server id, with the user message
   * the server will save for them. A row can be created and dispatched between
   * two polls, so it never shows up in `rows` at all — the disappeared-row
   * diff below only ever sees a row it observed first, and the reply then
   * arrives with no user message to attach to. Chasing our own rows by id is
   * what catches that case.
   */
  const enqueuedRef = useRef(new Map<string, UIMessage>())
  const [trackedCount, setTrackedCount] = useState(0)
  /**
   * The message of a row the server has taken but whose turn this window has
   * not attached to yet (it waits for the previous stream to close). Its queue
   * row is gone, so the transcript keeps painting the bubble from here until
   * `onTurnAvailable` hands it over.
   */
  const [pendingUserMessage, setPendingUserMessage] = useState<
    UIMessage | undefined
  >(undefined)
  const rowsRef = useRef<IChatQueuedMessage[]>([])
  const isStreamingRef = useRef(isStreaming)
  const onTurnAvailableRef = useRef(onTurnAvailable)

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
  /**
   * What the transcript should paint that the server has not saved as a
   * message yet — only the dispatched head that this window has not attached
   * to. A row still waiting on the queue belongs to the dock alone: it is not
   * a turn until the server starts one, and painting it early puts a message
   * in the transcript that a delete or an edit can no longer take back.
   *
   * The dispatched head is different: the server saved it and started its
   * turn, so it is a real message. It is painted from here only for the gap
   * between dispatch and the panel attaching (the previous stream may still
   * be closing), so the bubble does not blink out while its row leaves the
   * queue and its reply arrives.
   */
  const pendingUserMessages = useMemo(
    () => (pendingUserMessage ? [pendingUserMessage] : []),
    [pendingUserMessage],
  )

  rowsRef.current = rows
  isStreamingRef.current = isStreaming
  onTurnAvailableRef.current = onTurnAvailable

  useEffect(() => {
    previousIdsRef.current = []
    previousRowsRef.current = new Map()
    pendingTurnRef.current = null
    enqueuedRef.current.clear()
    setTrackedCount(0)
    setPendingUserMessage(undefined)
  }, [sessionId, enabled])

  const load = useCallback(async () => {
    if (!enabled || !sessionId) return
    await collection.loadAll({ sessionId })
  }, [collection, enabled, sessionId])

  const flushPendingTurn = useCallback(() => {
    if (isStreamingRef.current || !pendingTurnRef.current) return
    const { userMessage } = pendingTurnRef.current
    const notify = onTurnAvailableRef.current
    pendingTurnRef.current = null
    setPendingUserMessage(undefined)
    notify?.(userMessage)
  }, [])

  /**
   * A row this window enqueued that is no longer pending has been taken by the
   * server, which started its turn. Checked against `rows`, not against a
   * previous render: the row may have been dispatched between two polls and
   * never appeared there at all.
   */
  const drainEnqueued = useCallback(() => {
    const tracked = enqueuedRef.current
    if (tracked.size === 0) return
    const byId = new Map(rowsRef.current.map((row) => [row.id, row]))
    let dispatched: UIMessage | undefined
    let dropped = 0
    for (const [id, userMessage] of tracked) {
      const row = byId.get(id)
      if (row?.status === "pending") continue
      tracked.delete(id)
      dropped++
      // A failed dispatch stays on the queue with its error for the user to
      // retry; it is not a turn starting.
      if (row?.status === "failed") continue
      dispatched ??= userMessage
    }
    if (dropped > 0) setTrackedCount((count) => Math.max(0, count - dropped))
    if (!dispatched) return
    pendingTurnRef.current = { userMessage: dispatched }
    setPendingUserMessage(dispatched)
    flushPendingTurn()
  }, [flushPendingTurn])

  useEffect(() => {
    void load().catch((error) => {
      console.warn("[ChatQueue] Failed to load server queue:", error)
    })
  }, [load])

  useEffect(() => {
    if (!enabled || !sessionId || rows.length === 0 || isStreaming) return
    const timer = setInterval(() => {
      void load().then(() => drainEnqueued(), () => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [enabled, sessionId, rows.length, isStreaming, load, drainEnqueued])

  // A row this window enqueued that never appeared in `rows` never changes it
  // either, so the poll above (which only runs while something is queued)
  // would never look again. Keep polling while a row of ours is unaccounted
  // for, and stop as soon as the server's dispatch is seen.
  useEffect(() => {
    if (!enabled || !sessionId || trackedCount === 0) return
    const timer = setInterval(() => {
      void load().then(() => drainEnqueued(), () => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [enabled, sessionId, trackedCount, load, drainEnqueued])

  useEffect(() => {
    const previous = previousIdsRef.current
    const previousRows = previousRowsRef.current
    const current = new Set(rows.map((row) => row.id))
    previousRowsRef.current = new Map(rows.map((row) => [row.id, row]))
    previousIdsRef.current = rows.map((row) => row.id)
    // "Send now" moves any row to the front and the server can dispatch and
    // delete it before the client sees the new order, so the dispatched row
    // is not necessarily the head we last saw.
    let dispatchedId: string | undefined
    for (const id of previous) {
      if (current.has(id) || id.startsWith(OPTIMISTIC_ID_PREFIX)) continue
      if (userRemovedIdsRef.current.has(id)) {
        userRemovedIdsRef.current.delete(id)
        continue
      }
      dispatchedId ??= id
    }
    if (dispatchedId && !pendingTurnRef.current) {
      const removed = previousRows.get(dispatchedId)
      const userMessage = removed ? queuedRowToUserMessage(removed) : undefined
      pendingTurnRef.current = { userMessage }
      setPendingUserMessage(userMessage)
    }
    drainEnqueued()
    flushPendingTurn()
  }, [rows, drainEnqueued, flushPendingTurn])

  // Attaching while the previous turn's stream is still open (the server
  // stops it for "send now") would resume on top of a live stream.
  useEffect(() => {
    if (!isStreaming) flushPendingTurn()
  }, [isStreaming, flushPendingTurn])

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
      const created = (await collection.create({
        sessionId,
        userId: "",
        content: input.content.trim(),
        parts: JSON.stringify(parts),
        body: JSON.stringify(body),
      } as any)) as IChatQueuedMessage | undefined
      if (created && !created.id.startsWith(OPTIMISTIC_ID_PREFIX)) {
        enqueuedRef.current.set(created.id, queuedRowToUserMessage(created))
        setTrackedCount((count) => count + 1)
      }
      return created
    },
    [collection, sessionId],
  )

  const remove = useCallback(
    async (id: string) => {
      userRemovedIdsRef.current.add(id)
      // Delete is the only other way a row this window enqueued disappears, so
      // it must stop being tracked here: `drainEnqueued` reads a gone row as the
      // server having started its turn, and deleting a queued message is not
      // that.
      const tracked = enqueuedRef.current.get(id)
      if (tracked && enqueuedRef.current.delete(id)) {
        setTrackedCount((count) => Math.max(0, count - 1))
      }
      try {
        await collection.delete(id)
      } catch (error) {
        userRemovedIdsRef.current.delete(id)
        if (tracked) {
          enqueuedRef.current.set(id, tracked)
          setTrackedCount((count) => count + 1)
        }
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

  return {
    queuedMessages,
    pendingUserMessages,
    enqueue,
    remove,
    update,
    reorder,
    sendNow,
    isServerQueued,
    reload: load,
  }
}
