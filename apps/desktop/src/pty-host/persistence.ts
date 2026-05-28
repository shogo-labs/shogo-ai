// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-session snapshot store.
 *
 * Writes a small JSON document for each PTY session to disk so that:
 *
 *   - Renderer reload (⌘R) doesn't lose scrollback even when the host
 *     itself is alive — the renderer re-attaches via the existing
 *     since=N replay path, the snapshot is just insurance.
 *
 *   - App restart resurrects the SESSION SHAPE (cwd, shell, ring of
 *     bytes) but NOT the underlying process. The restored session is
 *     a fresh shell spawn in the saved cwd; the ring gets replayed
 *     into xterm immediately so the user sees the prior output.
 *
 * Design:
 *
 *   1. **Per-session file** under
 *      `<dir>/<workspaceHash>/<sessionId>.snap`. Workspace folders
 *      isolate scope — opening workspace B never sees A's terminals.
 *
 *   2. **Atomic writes**: write to `<file>.tmp`, then rename. Avoids
 *      partial JSON on crash. (Real `fs.rename` is atomic on the same
 *      filesystem on all the OSes Electron supports.)
 *
 *   3. **Debounced**: `update(snap)` coalesces multiple updates within
 *      a `debounceMs` window (default 1000ms) into one disk write.
 *      `flushAll()` is the synchronous escape hatch for shutdown
 *      hooks (`beforeQuit`, `SIGTERM`).
 *
 *   4. **Ring size cap**: callers pass the ring bytes already trimmed;
 *      we additionally enforce `maxRingBytes` (default 256 KiB) to
 *      guard against future regressions in the caller.
 *
 *   5. **Filesystem behind an interface**: `FsAdapter` shape mirrors
 *      the `node:fs/promises` subset we use (writeFile / readFile /
 *      readdir / mkdir / rename / unlink / stat). Tests inject an
 *      in-memory adapter; production wraps `fs/promises`.
 */

// ─── narrow FS interface ────────────────────────────────────────────

export interface FsAdapter {
  writeFile(path: string, data: string): Promise<void>
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  /** True iff the path exists. */
  exists(path: string): Promise<boolean>
}

// ─── snapshot shape ─────────────────────────────────────────────────

export interface SessionSnapshot {
  /** Schema version — bump on incompatible changes. */
  version: 1
  /** Stable session id (matches the host's runtime id at write time). */
  id: string
  /** Workspace this session belongs to. */
  workspaceHash: string
  /** Last cwd seen for this session. */
  cwd: string
  /** Shell binary path (used to re-spawn). */
  shell: string
  /** Optional profile id from Phase 5. */
  profileId?: string
  /** Last sequence number the snapshot accounts for. */
  lastSeq: number
  /**
   * Latest scrollback ring bytes (utf-8). Caller passes them already
   * capped to MAX_RING_BYTES. The store enforces the cap defensively.
   */
  ring: string
  /** Wall-clock ms when the snapshot was written. */
  writtenAt: number
}

// ─── options ────────────────────────────────────────────────────────

export interface SnapshotStoreOptions {
  /** Root directory under userData. The store creates subdirs per workspace. */
  dir: string
  fs: FsAdapter
  /** Debounce window in ms (default 1000). */
  debounceMs?: number
  /** Hard cap on ring bytes — default 256 KiB. */
  maxRingBytes?: number
  /** Wall clock (test injectable). */
  now?: () => number
  /** Scheduler (test injectable). */
  schedule?(cb: () => void, ms: number): number
  cancel?(handle: number): void
}

// ─── constants ──────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE = 1_000
const DEFAULT_MAX_RING = 256 * 1024
const SUFFIX = '.snap'
const TMP_SUFFIX = '.snap.tmp'

// ─── store ──────────────────────────────────────────────────────────

export class SnapshotStore {
  private readonly dir: string
  private readonly fs: FsAdapter
  private readonly debounceMs: number
  private readonly maxRingBytes: number
  private readonly now: () => number
  private readonly schedule: (cb: () => void, ms: number) => number
  private readonly cancel: (h: number) => void

  /** Pending snapshots awaiting flush, keyed by session id. */
  private pending = new Map<string, SessionSnapshot>()
  /** Per-session timer handle so we can cancel coalesced rewrites. */
  private timers = new Map<string, number>()
  /** Workspace dirs we've already mkdir'd this session. */
  private workspacesEnsured = new Set<string>()
  private disposed = false

  constructor(opts: SnapshotStoreOptions) {
    this.dir = opts.dir
    this.fs = opts.fs
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE)
    this.maxRingBytes = Math.max(1, opts.maxRingBytes ?? DEFAULT_MAX_RING)
    this.now = opts.now ?? Date.now
    if (opts.schedule && opts.cancel) {
      this.schedule = opts.schedule
      this.cancel = opts.cancel
    } else {
      this.schedule = (cb, ms) => setTimeout(cb, ms) as unknown as number
      this.cancel = (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
    }
  }

  /**
   * Enqueue a snapshot. Multiple updates with the same id within the
   * debounce window collapse into one write — the LATEST snapshot
   * wins. Returns immediately; the disk write happens later.
   */
  update(snap: Omit<SessionSnapshot, 'version' | 'writtenAt'>): void {
    if (this.disposed) return
    const trimmedRing = snap.ring.length > this.maxRingBytes
      ? snap.ring.slice(snap.ring.length - this.maxRingBytes)
      : snap.ring
    const full: SessionSnapshot = {
      version: 1,
      ...snap,
      ring: trimmedRing,
      writtenAt: this.now(),
    }
    this.pending.set(snap.id, full)
    const existing = this.timers.get(snap.id)
    if (existing !== undefined) this.cancel(existing)
    this.timers.set(snap.id, this.schedule(() => {
      this.timers.delete(snap.id)
      void this.flushOne(snap.id)
    }, this.debounceMs))
  }

  /**
   * Force-flush all pending snapshots. Awaits every write so callers
   * can `await store.flushAll()` from `beforeQuit` and know data hit
   * disk before the process exits.
   */
  async flushAll(): Promise<void> {
    // Cancel every timer first; we're about to do the work synchronously.
    for (const h of this.timers.values()) this.cancel(h)
    this.timers.clear()
    const ids = [...this.pending.keys()]
    await Promise.all(ids.map((id) => this.flushOne(id)))
  }

  /** List all snapshots for a workspace. Missing dir → []. */
  async list(workspaceHash: string): Promise<SessionSnapshot[]> {
    const dir = this.workspaceDir(workspaceHash)
    if (!(await this.fs.exists(dir))) return []
    let entries: string[]
    try { entries = await this.fs.readdir(dir) } catch { return [] }
    const out: SessionSnapshot[] = []
    for (const name of entries) {
      if (!name.endsWith(SUFFIX) || name.endsWith(TMP_SUFFIX)) continue
      const path = `${dir}/${name}`
      const snap = await this.readSnap(path)
      if (snap) out.push(snap)
    }
    // Most-recent first.
    out.sort((a, b) => b.writtenAt - a.writtenAt)
    return out
  }

  /** Load a single snapshot by id. Null on missing / malformed. */
  async load(workspaceHash: string, id: string): Promise<SessionSnapshot | null> {
    const path = this.snapPath(workspaceHash, id)
    if (!(await this.fs.exists(path))) return null
    return this.readSnap(path)
  }

  /** Delete a single snapshot. Returns true iff something was removed. */
  async delete(workspaceHash: string, id: string): Promise<boolean> {
    const path = this.snapPath(workspaceHash, id)
    if (!(await this.fs.exists(path))) return false
    try { await this.fs.unlink(path); return true } catch { return false }
  }

  /** Cancel all pending writes; further updates are no-ops. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const h of this.timers.values()) this.cancel(h)
    this.timers.clear()
    this.pending.clear()
  }

  // ─── internals ──────────────────────────────────────────────

  private async flushOne(id: string): Promise<void> {
    const snap = this.pending.get(id)
    if (!snap) return
    this.pending.delete(id)
    try {
      await this.ensureWorkspaceDir(snap.workspaceHash)
      const tmp = `${this.snapPath(snap.workspaceHash, snap.id)}.tmp`
      const final = this.snapPath(snap.workspaceHash, snap.id)
      await this.fs.writeFile(tmp, JSON.stringify(snap))
      await this.fs.rename(tmp, final)
    } catch { /* best-effort — disk full / readonly */ }
  }

  private async ensureWorkspaceDir(workspaceHash: string): Promise<void> {
    if (this.workspacesEnsured.has(workspaceHash)) return
    const dir = this.workspaceDir(workspaceHash)
    await this.fs.mkdir(dir, { recursive: true })
    this.workspacesEnsured.add(workspaceHash)
  }

  private async readSnap(path: string): Promise<SessionSnapshot | null> {
    let raw: string
    try { raw = await this.fs.readFile(path) } catch { return null }
    try {
      const parsed = JSON.parse(raw) as SessionSnapshot
      if (!parsed || parsed.version !== 1 || typeof parsed.id !== 'string') return null
      if (typeof parsed.cwd !== 'string' || typeof parsed.shell !== 'string') return null
      // Defensive ring trim on read in case an older writer was looser.
      if (parsed.ring && parsed.ring.length > this.maxRingBytes) {
        parsed.ring = parsed.ring.slice(parsed.ring.length - this.maxRingBytes)
      }
      return parsed
    } catch { return null }
  }

  private workspaceDir(workspaceHash: string): string {
    return `${this.dir}/${workspaceHash}`
  }

  private snapPath(workspaceHash: string, id: string): string {
    return `${this.workspaceDir(workspaceHash)}/${id}${SUFFIX}`
  }
}

// ─── in-memory FS for tests ─────────────────────────────────────────

/**
 * An `FsAdapter` backed by a Map. Hosts unit tests so we never touch
 * the real filesystem from this package's tests.
 */
export class MemoryFsAdapter implements FsAdapter {
  private files = new Map<string, string>()
  private dirs = new Set<string>()

  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data)
    this.ensureParents(path)
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path)
    if (v === undefined) throw new Error(`ENOENT: ${path}`)
    return v
  }
  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const out = new Set<string>()
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const slash = rest.indexOf('/')
      out.add(slash === -1 ? rest : rest.slice(0, slash))
    }
    return [...out]
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path)
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from)
    if (v === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.delete(from)
    this.files.set(to, v)
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`)
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path)
  }
  /** Test inspector. */
  files_(): ReadonlyMap<string, string> { return this.files }

  private ensureParents(path: string): void {
    const idx = path.lastIndexOf('/')
    if (idx > 0) this.dirs.add(path.slice(0, idx))
  }
}
