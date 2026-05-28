// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SnapshotStore — Phase 10.
 *
 * Captures the terminal's *visible* state (scrollback rows, cwd, last
 * command label) keyed by `sessionId`, then restores it on a subsequent
 * reload so a window refresh feels seamless.
 *
 * Design choices:
 *
 *   • Storage-agnostic. The store itself just calls a thin
 *     `SnapshotStorage` interface (get / set / delete). The Electron
 *     embedder backs it with SQLite via a Better-SQLite3 wrapper; tests
 *     back it with an in-memory `Map`. This package stays dep-free.
 *
 *   • Captures, never *replays the PTY*. We replay scrollback as raw
 *     `term.write()` bytes. The PTY reattachment on the host side fires
 *     the moment the surface mounts; whatever the PTY produces lands
 *     *after* the restored scrollback, exactly like VS Code.
 *
 *   • Caps at 5000 rows by default. That's roughly 4× a default xterm
 *     scrollback (1000) but well under the practical SQLite blob size
 *     boundary. Override via `maxRows` if the host wants tighter quotas.
 *
 * NOT in scope for Phase 10:
 *
 *   • Sxes restoration (we just dump the plain string). xterm's
 *     scrollback already encodes ANSI escapes, so writing the raw rows
 *     back into the terminal preserves colors — the *recording* is
 *     where ANSI fidelity dies, and we don't reach that side of the
 *     fence in this phase.
 *
 *   • Persistent PTY ownership — that's an OS-level concern owned by
 *     the agent runtime. We just persist the *renderer* state.
 */

import type { Terminal } from '@xterm/xterm'

/**
 * Tiny synchronous KV interface. Sync because Better-SQLite3 is sync
 * and that's what the Electron host uses. Async-backed embedders can
 * wrap their own adapter.
 *
 * Mirrors the same pattern as `ApprovalStore` so embedders get one
 * mental model for "give us a storage and we'll do the rest".
 */
export interface SnapshotStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  /** Optional — enables listSessionIds(). Defaults to no enumeration. */
  keys?(prefix?: string): string[]
}

/**
 * One snapshot. Lines are *visible terminal rows* in display order,
 * top to bottom, with trailing whitespace already stripped. They are
 * ready to be `term.write(line + '\\r\\n')`-ed back during restore.
 */
export interface Snapshot {
  sessionId: string
  cwd: string | null
  lines: string[]
  /** Label of the command running when the snapshot was taken (for UI). */
  activeCommand: string | null
  /** Unix ms when the snapshot was captured. */
  savedAt: number
  /** Schema version — bumped on incompatible changes. */
  v: 1
}

export interface SnapshotStoreOptions {
  storage: SnapshotStorage
  /** Hard cap on how many recent rows we serialise. Default 5000. */
  maxRows?: number
  /** Storage key namespace, defaults to 'shogo:term-snapshot:'. */
  keyPrefix?: string
  /** Override for tests. */
  now?: () => number
}

const DEFAULT_PREFIX = 'shogo:term-snapshot:'

export class SnapshotStore {
  private readonly storage: SnapshotStorage
  private readonly maxRows: number
  private readonly prefix: string
  private readonly now: () => number

  constructor(opts: SnapshotStoreOptions) {
    this.storage = opts.storage
    this.maxRows = opts.maxRows ?? 5000
    this.prefix = opts.keyPrefix ?? DEFAULT_PREFIX
    this.now = opts.now ?? (() => Date.now())
  }

  /** Persist a snapshot for `sessionId`. Overwrites any prior. */
  save(snapshot: Omit<Snapshot, 'savedAt' | 'v'>): Snapshot {
    const trimmed: Snapshot = {
      ...snapshot,
      lines: snapshot.lines.length > this.maxRows
        ? snapshot.lines.slice(snapshot.lines.length - this.maxRows)
        : snapshot.lines,
      savedAt: this.now(),
      v: 1,
    }
    this.storage.set(this.key(snapshot.sessionId), JSON.stringify(trimmed))
    return trimmed
  }

  /** Look up a snapshot by sessionId. Returns null if missing or stale. */
  load(sessionId: string): Snapshot | null {
    const raw = this.storage.get(this.key(sessionId))
    if (raw == null) return null
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isValidSnapshot(parsed)) return null
      // Future schema-bump branch goes here.
      return parsed
    } catch {
      return null
    }
  }

  /** Drop the snapshot for `sessionId`. Used on tab close. */
  clear(sessionId: string): void {
    this.storage.delete(this.key(sessionId))
  }

  /** Best-effort listing — only works if storage exposes keys(). */
  listSessionIds(): string[] {
    if (!this.storage.keys) return []
    return this.storage.keys(this.prefix).map((k) => k.slice(this.prefix.length))
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`
  }
}

/** Reject anything that doesn't look like our snapshot shape. */
function isValidSnapshot(x: unknown): x is Snapshot {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.v !== 1) return false
  if (typeof o.sessionId !== 'string') return false
  if (typeof o.savedAt !== 'number') return false
  if (!Array.isArray(o.lines)) return false
  if (!o.lines.every((l) => typeof l === 'string')) return false
  if (o.cwd != null && typeof o.cwd !== 'string') return false
  if (o.activeCommand != null && typeof o.activeCommand !== 'string') return false
  return true
}

// ─── In-memory storage for tests / standalone embedders ─────────────────

/**
 * Reference implementation of `SnapshotStorage`. Backed by a plain
 * `Map`. Used by the test suite; embedders can compose it with their
 * own persistence layer (e.g. write the whole map to localStorage on
 * `set`).
 */
export class InMemorySnapshotStorage implements SnapshotStorage {
  private readonly map = new Map<string, string>()
  get(key: string): string | null { return this.map.get(key) ?? null }
  set(key: string, value: string): void { this.map.set(key, value) }
  delete(key: string): void { this.map.delete(key) }
  keys(prefix?: string): string[] {
    const ks: string[] = []
    for (const k of this.map.keys()) {
      if (prefix == null || k.startsWith(prefix)) ks.push(k)
    }
    return ks
  }
}

// ─── xterm capture / restore helpers ───────────────────────────────────

/**
 * Pull the current scrollback off the terminal. Walks rows from the
 * top of the buffer (history) all the way to the bottom of the
 * viewport, stripping trailing whitespace per row. The result is
 * suitable for `SnapshotStore.save({ lines })`.
 *
 * Why `translateToString(true)` (trimRight=true)?
 *   xterm pads every row to terminal cols width — without trimming
 *   we'd write thousands of trailing spaces back into the new
 *   terminal, breaking word-wrap on restore.
 */
export function captureScrollback(term: Terminal, maxRows = 5000): string[] {
  const buf = term.buffer.active
  const total = buf.length // history + viewport rows
  if (total <= 0) return []
  const startRow = Math.max(0, total - maxRows)
  const rows: string[] = []
  for (let i = startRow; i < total; i += 1) {
    const ln = buf.getLine(i)
    rows.push(ln ? ln.translateToString(true) : '')
  }
  // Trim trailing blank lines so a freshly-mounted terminal doesn't
  // start half a screen down.
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

/**
 * Write a snapshot's lines back into a fresh terminal. Call this
 * *before* the PTY's first DATA frame lands so the restored output
 * scrolls above whatever the shell prints next.
 */
export function restoreScrollback(term: Terminal, snapshot: Snapshot): void {
  if (snapshot.lines.length === 0) return
  // CRLF between every row, then one final CRLF so the next PTY byte
  // starts on a clean line.
  for (let i = 0; i < snapshot.lines.length; i += 1) {
    term.write(snapshot.lines[i])
    if (i < snapshot.lines.length - 1) term.write('\r\n')
  }
  term.write('\r\n')
}
