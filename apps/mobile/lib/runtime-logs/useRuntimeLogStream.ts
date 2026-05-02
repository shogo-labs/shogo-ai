// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `useRuntimeLogStream` — subscribe a React component to a project's runtime
 * log buffer, opening an SSE stream against `/agent/runtime-logs/stream`
 * (with a polling fallback) and folding chat-derived exec entries into the
 * same buffer.
 *
 * The hook is intentionally narrow: it doesn't render, it doesn't filter,
 * it doesn't format. Callers consume `entries` and decide what to do.
 *
 * Why poll *and* SSE: SSE works in 99% of cases but a few hostile
 * intermediaries (corp proxies, some mobile carriers) break it. We
 * polling-fallback the moment the EventSource hits an error and never
 * recover automatically — once on poll, stay on poll for the life of
 * the hook to avoid churn.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { agentFetch } from '../agent-fetch'
import { createAuthedEventSource } from '../authed-event-source'
import { extractExecEntries, type ExecEntry } from '../../components/project/panels/extractExecEntries'
import {
  getCursor,
  getEntries,
  getUnseenErrorCount,
  pushEntries,
  pushEntry,
  subscribe,
  type RuntimeLogEntry,
} from './runtime-log-store'

const POLL_INTERVAL_MS = 3000

type EventSourceFactory = (url: string) => EventSource

interface UseRuntimeLogStreamArgs {
  projectId: string
  agentUrl: string | null
  /** Chat messages from `useChat`; we derive exec entries from them. */
  messages?: any[]
  /** Test seam: override the SSE constructor. */
  eventSourceFactory?: EventSourceFactory
  /** Test seam: override `fetch`. */
  fetcher?: typeof fetch
}

export interface UseRuntimeLogStreamResult {
  entries: ReadonlyArray<RuntimeLogEntry>
  unseenErrors: number
  /** True after the first successful response (snapshot or first SSE event). */
  ready: boolean
  /** Internal: which transport we're currently on, for testability. */
  transport: 'idle' | 'sse' | 'poll'
}

function execEntryToRuntimeLogEntry(e: ExecEntry): RuntimeLogEntry {
  const level: RuntimeLogEntry['level'] =
    e.exitCode !== 0 && e.exitCode !== -1 ? 'error' : 'info'
  const lines = [
    `$ ${e.command}`,
    e.stdout?.trim() || '',
    e.stderr?.trim() ? `[stderr] ${e.stderr.trim()}` : '',
  ].filter(Boolean)
  return {
    seq: 0,
    ts: e.timestamp,
    source: 'exec',
    level,
    text: lines.join('\n'),
    origin: 'exec',
  }
}

/** Track which exec ids we've already pushed for a given project. */
const seenExecByProject = new Map<string, Set<string>>()

/** Test-only: forget which exec ids we've pushed. */
export function __resetRuntimeLogStreamForTest(): void {
  seenExecByProject.clear()
}

export function useRuntimeLogStream(
  args: UseRuntimeLogStreamArgs,
): UseRuntimeLogStreamResult {
  const { projectId, agentUrl, messages, eventSourceFactory, fetcher } = args
  const transportRef = useRef<'idle' | 'sse' | 'poll'>('idle')
  const readyRef = useRef(false)

  const entries = useSyncExternalStore(
    (cb) => subscribe(projectId, cb),
    () => getEntries(projectId),
    () => getEntries(projectId),
  )
  const unseenErrors = useSyncExternalStore(
    (cb) => subscribe(projectId, cb),
    () => getUnseenErrorCount(projectId),
    () => getUnseenErrorCount(projectId),
  )

  // ─── Server transport ───────────────────────────────────────────────────
  useEffect(() => {
    if (!agentUrl) return
    const baseUrl = `${agentUrl}/agent/runtime-logs`
    const fetchImpl = fetcher ?? agentFetch
    const esFactory = eventSourceFactory ?? createAuthedEventSource

    let alive = true
    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const startPolling = (): void => {
      if (!alive) return
      transportRef.current = 'poll'
      const tick = async (): Promise<void> => {
        if (!alive) return
        try {
          const since = getCursor(projectId)
          const url =
            since > 0
              ? `${baseUrl}?since=${since}`
              : baseUrl
          const res = await fetchImpl(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = (await res.json()) as { entries?: RuntimeLogEntry[] }
          if (body.entries && body.entries.length > 0) {
            pushEntries(
              projectId,
              body.entries.map((e) => ({ ...e, origin: 'poll' })),
            )
          }
          readyRef.current = true
        } catch {
          // Swallow transient failures; keep polling.
        } finally {
          if (alive) pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
        }
      }
      void tick()
    }

    const startSse = (): void => {
      try {
        const since = getCursor(projectId)
        const url =
          since > 0
            ? `${baseUrl}/stream?since=${since}`
            : `${baseUrl}/stream`
        es = esFactory(url)
      } catch {
        startPolling()
        return
      }
      transportRef.current = 'sse'
      es.onmessage = (ev) => {
        if (!alive) return
        try {
          const entry = JSON.parse(ev.data) as RuntimeLogEntry
          pushEntry(projectId, { ...entry, origin: 'sse' })
          readyRef.current = true
        } catch {
          // Malformed event — drop.
        }
      }
      es.onerror = () => {
        if (!alive) return
        try {
          es?.close()
        } catch {
          // Already closed.
        }
        es = null
        startPolling()
      }
    }

    startSse()

    return () => {
      alive = false
      try {
        es?.close()
      } catch {
        // Best-effort.
      }
      if (pollTimer) clearTimeout(pollTimer)
      transportRef.current = 'idle'
    }
  }, [agentUrl, projectId, fetcher, eventSourceFactory])

  // ─── Chat exec merge ────────────────────────────────────────────────────
  // Derived from chat messages, not the SSE stream — these are *client-side*
  // entries that the agent runtime never sees. We dedupe by entry.id so
  // re-renders of the messages array don't re-push.
  const execEntries = useMemo(
    () => (messages ? extractExecEntries(messages) : []),
    [messages],
  )

  useEffect(() => {
    if (execEntries.length === 0) return
    let seen = seenExecByProject.get(projectId)
    if (!seen) {
      seen = new Set()
      seenExecByProject.set(projectId, seen)
    }
    const fresh: RuntimeLogEntry[] = []
    for (const e of execEntries) {
      if (e.exitCode === -1) continue
      if (seen.has(e.id)) continue
      seen.add(e.id)
      fresh.push(execEntryToRuntimeLogEntry(e))
    }
    if (fresh.length > 0) pushEntries(projectId, fresh)
  }, [execEntries, projectId])

  return {
    entries,
    unseenErrors,
    ready: readyRef.current,
    transport: transportRef.current,
  }
}
