// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * History aggregators for the "Recent Command" and "Recent Directory"
 * pickers. Both produce a deduped, recency-ordered list with a cheap
 * `filter(query)` for the picker input.
 *
 * Sources:
 *
 *   - **Tracker history** — every `Command.commandLine` from the
 *     Phase-3 tracker, plus every cwd we ever saw via P;Cwd or
 *     command.cwd.
 *
 *   - **Disk history (commands only)** — `~/.bash_history`,
 *     `~/.zsh_history`, `~/.local/share/fish/fish_history` (the YAML
 *     subset we care about). Read once, lazily, via an injectable
 *     `HistoryReader` so unit tests don't touch the FS.
 *
 *   - **Optional persisted recent dirs** — apps that want to share
 *     "recent dirs" across processes can pass an `ExtraDirsSource`
 *     pulling from electron-store etc. Not required.
 *
 * Filter mode is **fuzzy-substring**: the query is broken into
 * non-whitespace tokens; each token must be a case-insensitive
 * substring of the candidate, IN ORDER. Same model VS Code's
 * `cmdk`-style pickers use. Highlighting is left to the host.
 *
 * NB: the de-dup keeps the **most recent** occurrence (we slot the
 * fresh entry to the front and drop earlier instances).
 */

// ─── inputs ─────────────────────────────────────────────────────────

export interface CommandHistoryEntry {
  /** Display + value used by the picker. */
  command: string
  /** Optional cwd captured when the command ran. */
  cwd?: string
  /** Optional exit code (decorates the picker; tracker provides it). */
  exitCode?: number | null
  /** Source tag. Useful for icons / filters. */
  source: 'tracker' | 'bash' | 'zsh' | 'fish' | 'extra'
  /**
   * Stable id used for keyed React lists. Composed by the aggregator
   * out of (source + command + ordinal).
   */
  id: string
}

export interface DirectoryHistoryEntry {
  /** Absolute path. */
  path: string
  /** Source tag — same shape as commands for symmetry. */
  source: 'tracker' | 'extra'
  /** Stable id. */
  id: string
}

/** Subset of the tracker we need. */
export interface TrackerHistoryAdapter {
  commandHistory(): Array<{ commandLine: string; cwd: string | null; exitCode: number | null }>
  directoryHistory(): string[]
}

/** Disk-history reader. Async-friendly factory; the aggregator caches. */
export interface HistoryReader {
  readBash?(): Promise<string[]>
  readZsh?(): Promise<string[]>
  readFish?(): Promise<string[]>
}

export interface ExtraDirsSource {
  list(): string[]
}

// ─── command history ──────────────────────────────────────────────

export interface CommandHistoryOptions {
  tracker: TrackerHistoryAdapter
  reader?: HistoryReader
  /** Hard cap on returned entries. Default 500. */
  limit?: number
}

export class CommandHistorySource {
  private readonly tracker: TrackerHistoryAdapter
  private readonly reader: HistoryReader
  private readonly limit: number
  /** Lazily-populated disk entries — same shape as live tracker entries. */
  private diskEntries: CommandHistoryEntry[] | null = null
  /** Whether a `refreshDisk()` is currently in flight. */
  private refreshing: Promise<void> | null = null

  constructor(opts: CommandHistoryOptions) {
    this.tracker = opts.tracker
    this.reader = opts.reader ?? {}
    this.limit = Math.max(10, opts.limit ?? 500)
  }

  /**
   * Returns the current deduped+sorted list. Synchronous — disk
   * entries appear after the first `refreshDisk()` resolves.
   */
  list(): CommandHistoryEntry[] {
    const trackerEntries = this.tracker.commandHistory()
    const out: CommandHistoryEntry[] = []
    let n = 0
    // Tracker history is in chronological order (oldest first); we
    // want recency-first, so reverse.
    for (let i = trackerEntries.length - 1; i >= 0; i--) {
      const e = trackerEntries[i]!
      const cmd = e.commandLine.trim()
      if (!cmd) continue
      out.push({
        command: cmd,
        cwd: e.cwd ?? undefined,
        exitCode: e.exitCode,
        source: 'tracker',
        id: `tracker:${n++}:${cmd}`,
      })
    }
    if (this.diskEntries) {
      for (const e of this.diskEntries) out.push(e)
    }
    return dedupe(out, (e) => e.command).slice(0, this.limit)
  }

  /** Fuzzy-substring filter for the picker. */
  filter(query: string): CommandHistoryEntry[] {
    return fuzzyFilter(this.list(), (e) => e.command, query)
  }

  /**
   * Kick the disk readers; idempotent. The first call kicks off
   * the reads; subsequent calls re-use the in-flight promise.
   */
  refreshDisk(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.loadDisk().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  /** Drop the disk cache so the next refreshDisk re-reads. */
  resetDiskCache(): void { this.diskEntries = null }

  private async loadDisk(): Promise<void> {
    const collected: CommandHistoryEntry[] = []
    const sources: Array<[CommandHistoryEntry['source'], (() => Promise<string[]>) | undefined]> = [
      ['bash', this.reader.readBash?.bind(this.reader)],
      ['zsh', this.reader.readZsh?.bind(this.reader)],
      ['fish', this.reader.readFish?.bind(this.reader)],
    ]
    for (const [src, fn] of sources) {
      if (!fn) continue
      try {
        const lines = await fn()
        for (let i = lines.length - 1; i >= 0; i--) {
          const cmd = (lines[i] ?? '').trim()
          if (!cmd) continue
          collected.push({ command: cmd, source: src, id: `${src}:${i}:${cmd}` })
        }
      } catch { /* best-effort; missing or unreadable history is fine */ }
    }
    this.diskEntries = collected
  }
}

// ─── directory history ────────────────────────────────────────────

export interface DirectoryHistoryOptions {
  tracker: TrackerHistoryAdapter
  extras?: ExtraDirsSource
  limit?: number
}

export class DirectoryHistorySource {
  private readonly tracker: TrackerHistoryAdapter
  private readonly extras?: ExtraDirsSource
  private readonly limit: number

  constructor(opts: DirectoryHistoryOptions) {
    this.tracker = opts.tracker
    this.extras = opts.extras
    this.limit = Math.max(10, opts.limit ?? 200)
  }

  list(): DirectoryHistoryEntry[] {
    const tdir = this.tracker.directoryHistory()
    const out: DirectoryHistoryEntry[] = []
    let n = 0
    for (let i = tdir.length - 1; i >= 0; i--) {
      const p = tdir[i]!.trim()
      if (!p) continue
      out.push({ path: p, source: 'tracker', id: `tracker:${n++}:${p}` })
    }
    if (this.extras) {
      const xs = this.extras.list()
      for (let i = xs.length - 1; i >= 0; i--) {
        const p = xs[i]!.trim()
        if (!p) continue
        out.push({ path: p, source: 'extra', id: `extra:${n++}:${p}` })
      }
    }
    return dedupe(out, (e) => e.path).slice(0, this.limit)
  }

  filter(query: string): DirectoryHistoryEntry[] {
    return fuzzyFilter(this.list(), (e) => e.path, query)
  }
}

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Stable de-dupe by key — keeps the FIRST occurrence (since our lists
 * are recency-first, the first occurrence is the most recent).
 */
export function dedupe<T>(arr: readonly T[], key: (e: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const e of arr) {
    const k = key(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

/**
 * Fuzzy-substring filter: tokenise query on whitespace; every token
 * must appear (case-insensitive) in the candidate, IN ORDER, but
 * with arbitrary characters allowed between them.
 *
 * Empty query → original list (no filtering).
 */
export function fuzzyFilter<T>(arr: readonly T[], key: (e: T) => string, query: string): T[] {
  const q = query.trim()
  if (q.length === 0) return [...arr]
  const tokens = q.split(/\s+/).map((t) => t.toLowerCase())
  const out: T[] = []
  for (const item of arr) {
    const hay = key(item).toLowerCase()
    let cursor = 0
    let ok = true
    for (const tok of tokens) {
      const idx = hay.indexOf(tok, cursor)
      if (idx < 0) { ok = false; break }
      cursor = idx + tok.length
    }
    if (ok) out.push(item)
  }
  return out
}

/**
 * Convenience adapter — turn a Phase-3 Osc633Tracker into a
 * TrackerHistoryAdapter the history sources understand. We avoid a
 * direct dependency on the tracker module so the history sources can
 * be unit-tested with handwritten fakes.
 */
export interface MinimalTracker {
  snapshot(): {
    commands: ReadonlyArray<{ commandLine: string; cwd: string | null; exitCode: number | null }>
    cwd: string | null
  }
}

export function trackerAdapter(...trackers: readonly MinimalTracker[]): TrackerHistoryAdapter {
  return {
    commandHistory() {
      const out: { commandLine: string; cwd: string | null; exitCode: number | null }[] = []
      for (const t of trackers) {
        for (const c of t.snapshot().commands) {
          if (c.commandLine.trim().length === 0) continue
          out.push({ commandLine: c.commandLine, cwd: c.cwd ?? null, exitCode: c.exitCode })
        }
      }
      return out
    },
    directoryHistory() {
      // Dedupe is left to the source; preserve insertion order.
      const out: string[] = []
      for (const t of trackers) {
        const snap = t.snapshot()
        for (const c of snap.commands) {
          if (c.cwd) out.push(c.cwd)
        }
        if (snap.cwd) out.push(snap.cwd)
      }
      return out
    },
  }
}
