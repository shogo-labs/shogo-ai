// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The in-memory per-session transcript cache behind `ChatPanel`.
 *
 * It lives in its own module so sign-out can drop it without importing the
 * 9k-line panel (and the whole chat UI tree) into the auth bootstrap. Its
 * lifetime is one JS session; the durable copy is `chat-history-store`.
 *
 * The cache is bounded (SHO-434). It used to be a plain `Map` that lived until
 * the app was killed, so every chat opened in a session stayed on the JS heap
 * for the rest of it — and since a photo-heavy chat carries its image parts as
 * inline base64 URLs, a morning of browsing could hold a hundred megabytes of
 * transcript. That is what an Android `OutOfMemoryError` with "~1–2 MB free"
 * looks like, and on iOS the same growth is what the RAM watchdog kills the app
 * for. Nothing here needs an unbounded cache: an evicted chat just downloads
 * its page again, which is the deal `chat-history-store` already makes.
 *
 * Eviction is oldest-used-first across sessions, and the session just written
 * is never the one dropped — the panel is painting from it.
 */

import { transcriptBytes } from './message-bytes'

export { transcriptBytes }

/** What one surface may hold. Split, because a phone heap is not a desktop's. */
export interface SessionMessageCacheLimits {
  /** How many chats keep their transcript in memory. */
  sessions: number
  /** Approximate retained bytes across all of them. */
  bytes: number
}

const WEB_LIMITS: SessionMessageCacheLimits = { sessions: 20, bytes: 96 * 1024 * 1024 }
const NATIVE_LIMITS: SessionMessageCacheLimits = { sessions: 6, bytes: 24 * 1024 * 1024 }

/**
 * Browser and the Electron renderer both have IndexedDB; native does not. The
 * same test `chat-history-store` makes, kept local so dropping the caches on
 * sign-out never has to pull a storage backend into the auth bootstrap.
 */
function isWebSurface(): boolean {
  return typeof indexedDB !== 'undefined' && typeof window !== 'undefined'
}

export function sessionMessageCacheLimits(): SessionMessageCacheLimits {
  return isWebSurface() ? WEB_LIMITS : NATIVE_LIMITS
}

/** Test seam: hold the module to a budget a test can fill. Pass null to reset. */
let limitOverride: SessionMessageCacheLimits | null = null

export function setSessionMessageCacheLimits(
  limits: SessionMessageCacheLimits | null,
): void {
  limitOverride = limits
}

function limits(): SessionMessageCacheLimits {
  return limitOverride ?? sessionMessageCacheLimits()
}

interface CachedTranscript {
  messages: any[]
  bytes: number
  /** Monotonic use counter — a cheaper LRU key than a timestamp, and stable. */
  usedAt: number
}

const sessionMessageCache = new Map<string, CachedTranscript>()

let clock = 0

/**
 * Drop least-recently-used chats until the cache fits. `keep` is the session
 * that was just written or read and is never a candidate: the panel is showing
 * it, so evicting it would only guarantee a re-download on the next visit.
 */
function evictUntilWithinBudget(keep: string): void {
  const { sessions, bytes } = limits()
  let total = 0
  for (const entry of sessionMessageCache.values()) total += entry.bytes

  if (sessionMessageCache.size <= sessions && total <= bytes) return

  const candidates = Array.from(sessionMessageCache.entries())
    .filter(([sessionId]) => sessionId !== keep)
    .sort((a, b) => a[1].usedAt - b[1].usedAt)

  for (const [sessionId, entry] of candidates) {
    // One session on its own can exceed the byte budget (a long, photo-heavy
    // chat). Keep counting the count cap, but stop stripping the heap down to
    // nothing: the chat being read has to stay.
    const overCount = sessionMessageCache.size > sessions
    const overBytes = total > bytes
    if (!overCount && !overBytes) break
    sessionMessageCache.delete(sessionId)
    // Its thumbs go with it: the map is keyed by chat and lives as long as the
    // transcript does, so an evicted chat must not leave a row behind.
    sessionFeedbackCache.delete(sessionId)
    total -= entry.bytes
  }
}

/** The retained size of the whole cache, for diagnostics and tests. */
export function sessionMessageCacheUsage(): { sessions: number; bytes: number } {
  let bytes = 0
  for (const entry of sessionMessageCache.values()) bytes += entry.bytes
  return { sessions: sessionMessageCache.size, bytes }
}

/**
 * The caller's own thumbs up/down per session, keyed by `messageId`. Same
 * lifetime as the transcript cache: switching back to a session paints the
 * thumbs immediately instead of waiting on a round-trip.
 */
const sessionFeedbackCache = new Map<string, Record<string, 'up' | 'down'>>()

export function readSessionMessageCache(sessionId: string): any[] | undefined {
  const entry = sessionMessageCache.get(sessionId)
  if (!entry) return undefined
  // Re-insert so the map's own order stays the LRU order.
  entry.usedAt = ++clock
  sessionMessageCache.delete(sessionId)
  sessionMessageCache.set(sessionId, entry)
  return entry.messages
}

export function writeSessionMessageCache(sessionId: string, messages: any[]): void {
  // Measured on every write: the panel hands over a fresh array each render,
  // and a message object can grow (a streaming reply, a tool output landing),
  // so a total carried over from the previous write could under-count.
  const bytes = transcriptBytes(messages)
  sessionMessageCache.delete(sessionId)
  sessionMessageCache.set(sessionId, { messages, bytes, usedAt: ++clock })
  evictUntilWithinBudget(sessionId)
}

export function readSessionFeedbackCache(
  sessionId: string,
): Record<string, 'up' | 'down'> | undefined {
  return sessionFeedbackCache.get(sessionId)
}

export function writeSessionFeedbackCache(
  sessionId: string,
  feedback: Record<string, 'up' | 'down'>,
): void {
  // Re-insert so the map's own order is the use order.
  sessionFeedbackCache.delete(sessionId)
  sessionFeedbackCache.set(sessionId, feedback)
  // The thumbs are small, but they are still a per-chat map that would
  // otherwise live for the whole session; twice the transcript allowance leaves
  // room for a chat whose transcript was just evicted and is about to return.
  const cap = Math.max(1, limits().sessions * 2)
  for (const oldest of sessionFeedbackCache.keys()) {
    if (sessionFeedbackCache.size <= cap) break
    sessionFeedbackCache.delete(oldest)
  }
}

/**
 * Mirror one optimistic thumbs change so the cache never contradicts what the
 * panel is showing when the session is re-entered.
 */
export function patchSessionFeedbackCache(
  sessionId: string,
  messageId: string,
  thumbs: 'up' | 'down' | null,
): void {
  const current = sessionFeedbackCache.get(sessionId)
  if (!current) return
  const next = { ...current }
  if (thumbs) next[messageId] = thumbs
  else delete next[messageId]
  sessionFeedbackCache.set(sessionId, next)
}

/** Clear the in-memory per-session caches (e.g. on logout). */
export function clearChatPanelMessageCache(): void {
  sessionMessageCache.clear()
  sessionFeedbackCache.clear()
}
