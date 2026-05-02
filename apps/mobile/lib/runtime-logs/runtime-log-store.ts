// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-project ring buffer of runtime log entries (build / console / canvas-error / exec).
 *
 * The store is module-level singleton state intentionally: every IDE Output
 * tab and the legacy Monitor LogsPanel both subscribe to the same source so
 * they stay in sync without double-fetching `/agent/runtime-logs`.
 *
 * Subscribers receive a per-projectId notification whenever the buffer for
 * that project changes. We deliberately do *not* notify across projects:
 * many projects can be alive in the studio shell at once, but only one is
 * ever visible.
 *
 * The unseen-error counter drives the red dot on the BottomPanel's Output
 * tab. It increments only on `level: 'error'` entries that arrive *after*
 * the user has already opened the Output tab once (`markAllSeen`) — this
 * keeps the dot meaningful instead of red-dotting on every reload.
 */

export type RuntimeLogSource = 'console' | 'build' | 'canvas-error' | 'exec'
export type RuntimeLogLevel = 'info' | 'warn' | 'error'

export interface RuntimeLogEntry {
  /** Monotonically increasing sequence number from the server. */
  seq: number
  /** Wall-clock millis when the server recorded the entry. */
  ts: number
  source: RuntimeLogSource
  level: RuntimeLogLevel
  text: string
  surfaceId?: string
  /** Where the entry came from on the client side — server SSE vs chat-derived exec. */
  origin?: 'sse' | 'poll' | 'exec'
}

export const RUNTIME_LOG_BUFFER_CAP = 2000

type Listener = () => void

interface ProjectState {
  entries: RuntimeLogEntry[]
  unseenErrors: number
  /** Largest server-side seq observed for this project (for ?since polling). */
  cursor: number
}

const projects = new Map<string, ProjectState>()
const listenersByProject = new Map<string, Set<Listener>>()

function getOrCreate(projectId: string): ProjectState {
  let s = projects.get(projectId)
  if (!s) {
    s = { entries: [], unseenErrors: 0, cursor: 0 }
    projects.set(projectId, s)
  }
  return s
}

function notify(projectId: string): void {
  const set = listenersByProject.get(projectId)
  if (!set) return
  for (const l of set) {
    try {
      l()
    } catch {
      // Listener errors must not break siblings.
    }
  }
}

/**
 * Public read API. Returns a stable reference whenever the underlying
 * entries haven't changed — required for `useSyncExternalStore` to skip
 * re-renders.
 */
export function getEntries(projectId: string): ReadonlyArray<RuntimeLogEntry> {
  return projects.get(projectId)?.entries ?? EMPTY_ENTRIES
}
const EMPTY_ENTRIES: ReadonlyArray<RuntimeLogEntry> = Object.freeze([])

export function getUnseenErrorCount(projectId: string): number {
  return projects.get(projectId)?.unseenErrors ?? 0
}

export function getCursor(projectId: string): number {
  return projects.get(projectId)?.cursor ?? 0
}

/**
 * Push a single entry into the project's ring buffer. Out-of-order seq
 * numbers are dropped silently — the server is the source of truth and
 * the SSE stream is monotonic, so a lower seq means a stale poll
 * straggler we already saw.
 */
export function pushEntry(projectId: string, entry: RuntimeLogEntry): void {
  const state = getOrCreate(projectId)

  // Drop dupes / stragglers. Exec entries (which carry no server seq, see
  // mergeExecEntries) bypass this check.
  if (entry.origin !== 'exec' && entry.seq <= state.cursor && state.cursor > 0) {
    return
  }

  state.entries = [...state.entries, entry]
  if (state.entries.length > RUNTIME_LOG_BUFFER_CAP) {
    state.entries = state.entries.slice(state.entries.length - RUNTIME_LOG_BUFFER_CAP)
  }
  if (entry.origin !== 'exec' && entry.seq > state.cursor) {
    state.cursor = entry.seq
  }
  if (entry.level === 'error') {
    state.unseenErrors += 1
  }
  notify(projectId)
}

/**
 * Push a batch of entries (used by snapshot / poll fallback). Skips notify
 * until the end so subscribers only re-render once.
 */
export function pushEntries(
  projectId: string,
  entries: ReadonlyArray<RuntimeLogEntry>,
): void {
  if (entries.length === 0) return
  const state = getOrCreate(projectId)
  let appended: RuntimeLogEntry[] | null = null
  let errorBump = 0
  let highWater = state.cursor

  for (const entry of entries) {
    if (entry.origin !== 'exec' && entry.seq <= state.cursor && state.cursor > 0) {
      continue
    }
    if (!appended) appended = state.entries.slice()
    appended.push(entry)
    if (entry.level === 'error') errorBump += 1
    if (entry.origin !== 'exec' && entry.seq > highWater) highWater = entry.seq
  }
  if (!appended) return

  if (appended.length > RUNTIME_LOG_BUFFER_CAP) {
    appended = appended.slice(appended.length - RUNTIME_LOG_BUFFER_CAP)
  }
  state.entries = appended
  state.cursor = highWater
  state.unseenErrors += errorBump
  notify(projectId)
}

/**
 * Clear the visible buffer for a project — the user pressed "Clear" in
 * the Output tab. Server-side log buffer is untouched. Cursor is
 * preserved so we don't re-pull entries we already saw.
 */
export function clearProject(projectId: string): void {
  const state = projects.get(projectId)
  if (!state) return
  state.entries = []
  state.unseenErrors = 0
  notify(projectId)
}

/**
 * Mark all visible errors as seen — called when the user opens the
 * Output tab. The red dot turns off until the next error arrives.
 */
export function markAllSeen(projectId: string): void {
  const state = projects.get(projectId)
  if (!state || state.unseenErrors === 0) return
  state.unseenErrors = 0
  notify(projectId)
}

export function subscribe(projectId: string, listener: Listener): () => void {
  let set = listenersByProject.get(projectId)
  if (!set) {
    set = new Set()
    listenersByProject.set(projectId, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listenersByProject.delete(projectId)
  }
}

/** Test-only. */
export function __resetRuntimeLogStoreForTest(): void {
  projects.clear()
  listenersByProject.clear()
}
