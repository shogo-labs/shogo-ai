// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Chat, type UIMessage } from "@ai-sdk/react"
import type { ChatInit } from "ai"

/**
 * `useChat` publishes message updates from inside the SDK's stream processing:
 * every chunk calls `write()` → `replaceMessage()` → the subscriber, and
 * `experimental_throttle` is a leading-edge `throttleit`, so once a render
 * takes longer than the throttle window every chunk becomes a synchronous
 * SyncLane render. A buffered burst of chunks (hundreds of `tool-input-delta`s
 * from one network read) is processed back to back with only microtasks in
 * between, so React never gets a macrotask to flush the Default-lane work each
 * commit leaves behind, and its nested-update guard throws "Maximum update
 * depth exceeded" (#185) inside the SDK's `write()` — ending the stream.
 *
 * The publisher below never calls the subscriber synchronously: it publishes
 * at most once per macrotask, and no earlier than `max(waitMs, lastCost)` after
 * the previous publication's commit finished, which caps rendering at about
 * half of the main thread however slow a render gets.
 */
export const DEFAULT_PUBLISH_WAIT_MS = 50

export interface PacedPublisherOptions {
  waitMs: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => unknown
  cancelScheduled?: (handle: unknown) => void
  /**
   * Runs after the work `onChange` queued. React flushes a SyncLane store
   * update in a microtask queued during `onChange`, so a microtask queued
   * afterwards observes the end of that commit.
   */
  afterCommit?: (fn: () => void) => void
}

export interface PacedPublisher {
  /** Ask for a publication; coalesces with any already scheduled. */
  request: () => void
  /** Publish now if one is pending. */
  flush: () => void
  cancel: () => void
  isPending: () => boolean
}

const defaultNow = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now())

export function createPacedPublisher(onChange: () => void, options: PacedPublisherOptions): PacedPublisher {
  const {
    waitMs,
    now = defaultNow,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    afterCommit = (fn) => queueMicrotask(fn),
  } = options
  let handle: unknown = null
  let pending = false
  let nextAllowedAt = 0
  let cancelled = false

  const fire = () => {
    handle = null
    pending = false
    if (cancelled) return
    const start = now()
    onChange()
    afterCommit(() => {
      const end = now()
      nextAllowedAt = end + Math.max(waitMs, end - start)
    })
  }

  return {
    request() {
      if (cancelled || pending) return
      pending = true
      handle = schedule(fire, Math.max(0, nextAllowedAt - now()))
    },
    flush() {
      if (!pending) return
      if (handle !== null) cancelScheduled(handle)
      fire()
    },
    cancel() {
      cancelled = true
      pending = false
      if (handle !== null) cancelScheduled(handle)
      handle = null
    },
    isPending: () => pending,
  }
}

export type PacedChatInit<M extends UIMessage> = ChatInit<M> & {
  /** Minimum gap between message publications (replaces `experimental_throttle`). */
  publishWaitMs?: number
}

/** Internal `Chat` members PacedChat wraps; they are not part of the SDK's public API. */
export const PACED_CHAT_SDK_HOOKS = [
  "~registerMessagesCallback",
  "~registerStatusCallback",
  "~registerErrorCallback",
] as const

/**
 * A `Chat` whose message subscribers are paced by {@link createPacedPublisher}.
 * Status and error subscribers stay synchronous, but any pending message
 * publication is flushed first, so the complete message is visible no later
 * than `ready` / `error`.
 */
export class PacedChat<M extends UIMessage = UIMessage> extends Chat<M> {
  constructor({ publishWaitMs = DEFAULT_PUBLISH_WAIT_MS, ...init }: PacedChatInit<M>) {
    super(init)
    for (const name of PACED_CHAT_SDK_HOOKS) {
      if (typeof this[name] !== "function") {
        throw new Error(
          `PacedChat: @ai-sdk/react Chat no longer has a "${name}" function; update paced-chat.ts for the installed SDK version.`,
        )
      }
    }
    const registerMessages = this["~registerMessagesCallback"]
    const registerStatus = this["~registerStatusCallback"]
    const registerError = this["~registerErrorCallback"]
    const publishers = new Set<PacedPublisher>()
    const flushAll = () => {
      for (const publisher of publishers) publisher.flush()
    }

    this["~registerMessagesCallback"] = (onChange) => {
      const publisher = createPacedPublisher(onChange, { waitMs: publishWaitMs })
      publishers.add(publisher)
      const unsubscribe = registerMessages(publisher.request)
      return () => {
        publishers.delete(publisher)
        publisher.cancel()
        unsubscribe()
      }
    }
    this["~registerStatusCallback"] = (onChange) =>
      registerStatus(() => {
        flushAll()
        onChange()
      })
    this["~registerErrorCallback"] = (onChange) =>
      registerError(() => {
        flushAll()
        onChange()
      })
  }
}
