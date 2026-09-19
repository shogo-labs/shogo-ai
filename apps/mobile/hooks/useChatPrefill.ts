// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useSyncExternalStore } from 'react'

/**
 * Cross-tab staged draft for the personal companion's primary chat.
 *
 * Several surfaces outside the Chat tab (a "Needs your OK" approval card in
 * Goals/Activity, a deliverable's "Ask about this" action, a goal's
 * "Check in" button, ...) want to say "open the primary chat with this text
 * pre-typed" without themselves rendering `ChatPanel`. `PersonalHomeScreen`
 * owns the composer and is the sole consumer: it reads this store once on
 * focus (see `useConsumeChatPrefill`), turns it into a `RestoreDraftRequest`,
 * and clears it — mirroring the same `nonce` + "clear only if unconsumed"
 * pattern `PersonalHomeScreen` already uses for its own avatar-change
 * prefill (`handlePrefillConsumed`), just shared across route boundaries via
 * `useSyncExternalStore` instead of local component state.
 */
export interface ChatPrefillRequest {
  nonce: number
  content: string
}

let state: ChatPrefillRequest | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ChatPrefillRequest | null {
  return state
}

/** Stage `content` to prefill the primary companion chat and navigate there. */
export function setChatPrefill(content: string): void {
  state = { nonce: Date.now(), content }
  for (const listener of listeners) listener()
}

/** Clear the store; used by the consumer once the draft has been applied. */
export function clearChatPrefill(nonce: number): void {
  if (state?.nonce !== nonce) return
  state = null
  for (const listener of listeners) listener()
}

/** Read the pending cross-tab prefill, re-rendering the caller whenever it changes. */
export function useChatPrefill(): ChatPrefillRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
