// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live agent replies, one subscription per message id (SHO-600).
 *
 * A delta replaces `TimelineState.streaming` wholesale. Passing that map down
 * gave every mounted row a new prop, so one streamed character re-rendered the
 * whole channel; passing it into `renderItem` did the same to the list. The
 * store keeps the map out of the row's props: a row subscribes to its own id
 * and only the streaming row re-renders when its text arrives.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { TimelineState } from './team-chat-state'

export type StreamingEntry = TimelineState['streaming'][string]

export interface StreamingStore {
  /** The live entry for a message, or undefined when it isn't streaming. */
  get(id: string): StreamingEntry | undefined
  subscribe(id: string, notify: () => void): () => void
  /** Publish a new map, waking only the ids whose entry changed. */
  set(next: Record<string, StreamingEntry>): void
}

export function createStreamingStore(): StreamingStore {
  let entries: Record<string, StreamingEntry> = {}
  const listeners = new Map<string, Set<() => void>>()
  return {
    get: (id) => entries[id],
    subscribe(id, notify) {
      let set = listeners.get(id)
      if (!set) {
        set = new Set()
        listeners.set(id, set)
      }
      set.add(notify)
      return () => {
        const current = listeners.get(id)
        if (!current) return
        current.delete(notify)
        if (!current.size) listeners.delete(id)
      }
    },
    set(next) {
      if (next === entries) return
      const prev = entries
      entries = next
      for (const id of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (prev[id] === next[id]) continue
        const set = listeners.get(id)
        if (!set) continue
        for (const notify of [...set]) notify()
      }
    },
  }
}

export const StreamingContext = createContext<StreamingStore | null>(null)

/**
 * This message's live reply, if it has one. Without a provider (a bare row, a
 * test) it reports nothing and the caller keeps its `streaming` prop.
 */
export function useStreamingEntry(id: string | undefined): StreamingEntry | undefined {
  const store = useContext(StreamingContext)
  const subscribe = useCallback(
    (notify: () => void) => (store && id ? store.subscribe(id, notify) : () => {}),
    [store, id],
  )
  const snapshot = useCallback(() => (store && id ? store.get(id) : undefined), [store, id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
