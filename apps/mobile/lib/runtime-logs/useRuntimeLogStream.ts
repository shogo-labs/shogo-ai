// SPDX-License-Identifier: MIT
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
 * Why poll at all: SSE works in 99% of cases but a few hostile
 * intermediaries (corp proxies, some mobile carriers) break it. Polling is a
 * bridge for that outage only — the stream is always retried (2→30 s) and a
 * successful open stops the poll and restores SSE. A healthy stream costs
 * zero polling requests, and a hidden tab costs nothing at all. The shared
 * policy lives in `../stream-fallback`.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { agentFetch } from '../agent-fetch'
import { createAuthedEventSource } from '../authed-event-source'
import { appVisibility, createStreamFallback } from '../stream-fallback'
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
    const visibility = appVisibility()

    let alive = true
    let es: EventSource | null = null

    const poll = async (): Promise<void> => {
      const since = getCursor(projectId)
      const url = since > 0 ? `${baseUrl}?since=${since}` : baseUrl
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
    }

    // SSE is the transport; the poll only bridges an outage (see
    // `lib/stream-fallback`). A dropped stream is retried at 2→30 s and the
    // hook goes back to SSE the moment a retry opens.
    const fallback = createStreamFallback({
      isVisible: visibility.isVisible,
      subscribeVisibility: visibility.subscribe,
      onTransportChange: (t) => {
        transportRef.current = t
      },
      poll,
      connect: (hooks) => {
        if (!alive) return () => {}
        const since = getCursor(projectId)
        const url =
          since > 0
            ? `${baseUrl}/stream?since=${since}`
            : `${baseUrl}/stream`
        try {
          es = esFactory(url)
        } catch {
          // Let the fallback schedule a retry instead of settling on poll.
          hooks.onError()
          return () => {}
        }
        const current = es
        current.onopen = () => {
          if (alive) hooks.onOpen()
        }
        current.onmessage = (ev) => {
          if (!alive) return
          // A delivered event is proof the stream is healthy — mark it open
          // so the retry ladder resets even if `onopen` never fired.
          hooks.onOpen()
          try {
            const entry = JSON.parse(ev.data) as RuntimeLogEntry
            pushEntry(projectId, { ...entry, origin: 'sse' })
            readyRef.current = true
          } catch {
            // Malformed event — drop.
          }
        }
        current.onerror = () => {
          if (alive) hooks.onError()
        }
        return () => {
          try {
            current.close()
          } catch {
            // Already closed.
          }
          if (es === current) es = null
        }
      },
    })

    fallback.start()

    return () => {
      alive = false
      fallback.stop()
      es = null
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
