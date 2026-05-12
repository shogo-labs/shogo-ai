// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helper for ChatPanel's "should I fetch /chat-messages?" decision —
 * the body of Effect 1 in `ChatPanel.tsx` (the stale-while-revalidate
 * loader that hydrates the AI SDK's `messages` array on tab activate).
 *
 * Effect 1 mixes a handful of orthogonal concerns:
 *   - gate on `isActive` so background tabs don't fire requests
 *   - skip while a streaming turn owns the SDK message buffer
 *   - dedupe in-flight loads via the `isLoadingMessages` flag
 *   - 5-second freshness bailout to absorb the loading-flag round-trip
 *     (without it, every `setIsLoadingMessages(false)` would re-enter
 *     the effect and refetch — see commit 82ac7815)
 *   - finally: fetch + mark `isInitialLoadComplete` so `useChat`'s
 *     resumeStream can attach to the runtime's durable buffer
 *
 * Splitting the decision out lets us unit-test each gate in isolation
 * without standing up the whole React tree, and locks down the regression
 * surface around the freshness bailout (which is easy to get subtly wrong
 * — it has caused both fetch-spam and fetch-skip bugs in the past).
 */

export interface ChatLoadDecisionInput {
  /** Whether this ChatPanel tab is currently the active one. */
  isActive: boolean
  /** The chat session id this panel is bound to (null if no session). */
  currentSessionId: string | null
  /** True while the AI SDK is mid-turn (status === 'streaming' | 'submitted'). */
  isStreaming: boolean
  /** True between a user submit and the SDK acknowledging it. */
  isSendingMessage: boolean
  /** True if a /chat-messages fetch is already in flight (dedupe guard). */
  isLoadingMessages: boolean
  /** True if `cachedMessagesRef.current` has any UIMessage entries. */
  hasCachedMessages: boolean
  /**
   * Last `performance.now()` at which the freshness stamp was set for the
   * current session, OR `undefined` if no successful (or attempted) load
   * has stamped one yet. Distinguishing undefined from 0 is what stops the
   * "fresh page refresh, performance.now() < 5000" false-bailout (the bug
   * you're testing for here).
   */
  cacheRefreshedAt: number | undefined
  /** Current monotonic clock reading (i.e. `performance.now()`). */
  now: number
}

export type ChatLoadAction =
  /** No work to do — a higher-priority gate fired (inactive tab, in-flight load, etc). */
  | { kind: "noop"; reason: string }
  /**
   * No session selected — flip `isInitialLoadComplete=true` so downstream
   * "loading" UI clears, then return.
   */
  | { kind: "mark-complete-no-session" }
  /**
   * Streaming is live and we have a non-empty cache — hydrate the SDK
   * `messages` array so the panel can render *something* immediately,
   * then mark complete. No network call.
   */
  | { kind: "hydrate-while-streaming" }
  /**
   * Cache was stamped fresh in the last 5s — skip the network fetch.
   * Caller should still hydrate from cache (if any) and mark complete.
   */
  | { kind: "skip-fresh-cache" }
  /**
   * Run the /chat-messages fetch. The caller is responsible for setting
   * the in-flight flag, kicking the request, and stamping the cache
   * timestamp in `.finally()` so this branch self-disables for the next 5s.
   */
  | { kind: "fetch" }

const FRESHNESS_WINDOW_MS = 5_000

/**
 * Decide what Effect 1 should do for the given input snapshot. The output
 * is a pure value; the React component then routes each case to the
 * matching `setMessages` / `setIsInitialLoadComplete` / `loadPage` calls.
 */
export function decideChatMessageLoadAction(
  input: ChatLoadDecisionInput,
): ChatLoadAction {
  const {
    isActive,
    currentSessionId,
    isStreaming,
    isSendingMessage,
    isLoadingMessages,
    hasCachedMessages,
    cacheRefreshedAt,
    now,
  } = input

  if (!isActive) {
    return { kind: "noop", reason: "tab-inactive" }
  }

  if (!currentSessionId) {
    return { kind: "mark-complete-no-session" }
  }

  if (isStreaming || isSendingMessage) {
    return { kind: "hydrate-while-streaming" }
  }

  if (isLoadingMessages) {
    return { kind: "noop", reason: "load-in-flight" }
  }

  // Freshness bailout: skip the fetch if the cache was stamped within
  // the last 5s. CRITICAL: an *unset* `cacheRefreshedAt` (no entry in
  // the per-session map) means "never loaded for this session" and MUST
  // fall through to fetch — NOT be coerced to 0, which would make every
  // mount within 5s of page load (i.e. every page refresh) hit the
  // bailout instead of fetching. That regression is what the
  // 'page refresh fires resume but skips fetch' suite locks down.
  if (cacheRefreshedAt !== undefined && now - cacheRefreshedAt < FRESHNESS_WINDOW_MS) {
    return { kind: "skip-fresh-cache" }
  }

  return { kind: "fetch" }
}
