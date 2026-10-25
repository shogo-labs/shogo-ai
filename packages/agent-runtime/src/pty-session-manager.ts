// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PtySessionManager — owns the workspace's terminal sessions.
 *
 * One manager per runtime pod (one runtime pod per workspace). Each
 * session is a PtySession (one persistent shell). Sessions are
 * server-owned; the WS connection just attaches to and detaches from
 * them, so a tab refresh / network blip doesn't kill `bun dev`.
 *
 * Lifecycle rules:
 *   - `create()` — allocates a new session at most up to `maxSessions`.
 *   - `attach()` / `detach()` — bookkeeping for which WS owns which.
 *     Detach without re-attach within `gracePeriodMs` triggers `kill()`.
 *   - `idleTimeoutMs` — sessions with no `write()` traffic for this long
 *     get reaped. Defaults to 30 min so an abandoned tab doesn't hold
 *     a shell open forever.
 *   - `maxAgeMs` — hard cap (default 24h) so even an actively-used
 *     session eventually rolls.
 *
 * Time source is injected via `now()` so tests can drive it without
 * waiting on real timers. `setInterval` for the sweep is also
 * configurable (we use it once at startup; tests skip it).
 */

import { PtySession, type PtySpawnOptions } from './pty-session'
import { ingestChunk as ingestDetectedUrlChunk, clearDetection as clearDetectedUrl } from './detected-urls'

export interface ManagerOptions {
  workspaceDir: string
  maxSessions?: number
  /** Idle (no input) before reap. Default 30 min. */
  idleTimeoutMs?: number
  /** Hard cap on session age. Default 24 h. */
  maxAgeMs?: number
  /** How long a session can sit detached before reap. Default 60 s. */
  gracePeriodMs?: number
  /** How often to scan for reapable sessions. Default 30 s; 0 disables. */
  sweepIntervalMs?: number
  now?: () => number
  /** Hook for tests to substitute a fake PtySession. */
  spawnSession?: (opts: PtySpawnOptions) => PtySession
}

export interface CreateSessionOptions {
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string | undefined>
  cmd?: string[]
}

interface SessionRecord {
  id: string
  session: PtySession
  createdAt: number
  /** Number of currently-attached WS clients. We allow one for now but the
   * field is generic to ease future "view-only second pane" support. */
  attached: number
  /** Time the last attach dropped to 0; used for grace-period reap. */
  detachedAt: number | null
}

const DEFAULTS = {
  maxSessions: 8,
  idleTimeoutMs: 30 * 60 * 1000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  gracePeriodMs: 60 * 1000,
  sweepIntervalMs: 30 * 1000,
}

export type ReapReason = 'idle' | 'max-age' | 'detach-grace' | 'exited' | 'killed' | 'shutdown'

export class PtySessionManager {
  readonly workspaceDir: string
  readonly maxSessions: number
  readonly idleTimeoutMs: number
  readonly maxAgeMs: number
  readonly gracePeriodMs: number
  private readonly sweepIntervalMs: number
  private readonly now: () => number
  private readonly spawnSession: (opts: PtySpawnOptions) => PtySession
  private readonly sessions = new Map<string, SessionRecord>()
  private sweeper: ReturnType<typeof setInterval> | null = null
  private reapListeners = new Set<(id: string, reason: ReapReason) => void>()
  private idCounter = 0

  constructor(opts: ManagerOptions) {
    this.workspaceDir = opts.workspaceDir
    this.maxSessions = opts.maxSessions ?? DEFAULTS.maxSessions
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULTS.maxAgeMs
    this.gracePeriodMs = opts.gracePeriodMs ?? DEFAULTS.gracePeriodMs
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs
    this.now = opts.now ?? (() => Date.now())
    this.spawnSession = opts.spawnSession ?? ((o) => new PtySession(o))
    if (this.sweepIntervalMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs)
      // Don't keep the event loop alive for sweeps; the runtime owns the
      // process lifetime via its HTTP server.
      this.sweeper.unref?.()
    }
  }

  list(): Array<{ id: string; createdAt: number; cwd: string; attached: number }> {
    return [...this.sessions.values()].map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      cwd: r.session.cwd,
      attached: r.attached,
    }))
  }

  get(id: string): PtySession | null {
    return this.sessions.get(id)?.session ?? null
  }

  create(opts: CreateSessionOptions = {}): SessionRecord {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`max-sessions-reached: workspace has ${this.maxSessions} active terminals`)
    }
    const id = this.nextId()
    const session = this.spawnSession({
      cmd: opts.cmd,
      cwd: opts.cwd ?? this.workspaceDir,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      env: opts.env,
    })
    const rec: SessionRecord = {
      id,
      session,
      createdAt: this.now(),
      attached: 0,
      detachedAt: this.now(), // born detached → grace-period clock starts
    }
    this.sessions.set(id, rec)
    // If the shell exits on its own (`exit` typed by the user), reap.
    session.onExit(() => this.reap(id, 'exited'))

    // Passive URL-detection: tap every chunk and feed the dev-server
    // regex set in `detected-urls.ts`. This is purely observational; we
    // never block, transform, or buffer the data path for the WS handler
    // — `onData` listeners run independently.
    session.onData(({ bytes }) => {
      try { ingestDetectedUrlChunk(id, bytes) } catch {}
    })

    return rec
  }

  /** Mark `id` attached. Returns the session or null if unknown/exited. */
  attach(id: string): PtySession | null {
    const rec = this.sessions.get(id)
    if (!rec || rec.session.isExited) return null
    rec.attached += 1
    rec.detachedAt = null
    return rec.session
  }

  /** Mark `id` detached. Starts grace-period clock if no other attaches. */
  detach(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    rec.attached = Math.max(0, rec.attached - 1)
    if (rec.attached === 0) rec.detachedAt = this.now()
  }

  /** Hard-kill `id` and remove from the registry. Idempotent. */
  kill(id: string): void {
    this.reap(id, 'killed')
  }

  /** Tear down everything. Call on runtime shutdown. */
  shutdown(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    for (const id of [...this.sessions.keys()]) this.reap(id, 'shutdown')
    this.reapListeners.clear()
  }

  /** Subscribe to reap events. Useful for the WS handler to close clients. */
  onReap(cb: (id: string, reason: ReapReason) => void): () => void {
    this.reapListeners.add(cb)
    return () => { this.reapListeners.delete(cb) }
  }

  /** Public so tests can drive deterministically. */
  sweep(): void {
    const now = this.now()
    for (const [id, rec] of this.sessions) {
      if (rec.session.isExited) {
        this.reap(id, 'exited')
        continue
      }
      if (rec.attached === 0 && rec.detachedAt != null) {
        if (now - rec.detachedAt > this.gracePeriodMs) {
          this.reap(id, 'detach-grace')
          continue
        }
      }
      if (now - rec.session.lastActivity > this.idleTimeoutMs) {
        this.reap(id, 'idle')
        continue
      }
      if (now - rec.createdAt > this.maxAgeMs) {
        this.reap(id, 'max-age')
        continue
      }
    }
  }

  private reap(id: string, reason: ReapReason): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    this.sessions.delete(id)
    try { rec.session.dispose() } catch {}
    try { clearDetectedUrl(id) } catch {}
    for (const cb of this.reapListeners) {
      try { cb(id, reason) } catch {}
    }
  }

  private nextId(): string {
    // Random-looking but readable; collisions are vanishingly unlikely
    // within a single workspace and we Map-check anyway.
    this.idCounter += 1
    const rand = Math.random().toString(36).slice(2, 8)
    return `t${this.idCounter.toString(36)}-${rand}`
  }
}
