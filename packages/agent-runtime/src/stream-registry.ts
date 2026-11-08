// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The set of agent turns currently streaming into a chat buffer.
 *
 * Why a registry and not a counter
 * ===============================
 * `activeStreams` used to be a bare `++`/`--` pair around `bufferedTurns.start`.
 * The `--` only runs once the turn settles, and a turn whose model fetch is a
 * dead socket (a guest restored from a snapshot, a proxy connection frozen
 * mid-read) never settles — not even after `abortCurrentTurn`, which drops the
 * session's turn lock first and aborts a controller the wedged fetch may no
 * longer be listening to. The pod then reports `activeStreams: 1` with
 * `activeTurns: 0` forever, and every host-side idle check treats the VM as
 * busy: it is never suspended, never resumed, never recycled, and so never gets
 * a fresh AI-proxy token (SHO-348).
 *
 * A counter cannot be reconciled because it has no owner to ask "is this still
 * yours?". This registry records each turn with its session, its start time and
 * the time of its last buffer progress, so an entry can be evicted when the
 * session no longer holds a turn lock AND the buffer has gone quiet for TTL.
 *
 * The TTL rule is deliberately conservative: a turn whose session still holds
 * the turn lock is never reaped, however long it has been quiet — a long tool
 * call, a slow model or an `exec` that buffers nothing for minutes is a real
 * turn, and killing it would be worse than the bug this fixes.
 *
 * Why there is no guest-side model-fetch timeout
 * =============================================
 * The plan for SHO-348 also asked to bound the model fetch so a dead socket
 * after a restore cannot hang forever. Two layers already bound the part that
 * can be bounded:
 *   - the API's AI proxy has a byte-level idle watchdog (`MAX_IDLE_MS`, 120 s in
 *     `apps/api/src/routes/ai-proxy.ts`): no upstream bytes for two minutes and
 *     it emits a retryable `idle_timeout` and cancels, which the loop retries;
 *   - `abortCurrentTurn` aborts the turn's controller, which the SDK's fetch
 *     honours whenever the socket is still healthy enough to receive the abort.
 * The residual case — a half-open guest↔API socket after a snapshot restore,
 * where the proxy's error frame can never reach the guest — cannot be bounded
 * from the guest's event iterator: pi-ai owns the transport, and the only thing
 * visible there is parsed events, not bytes. An event-level watchdog would kill
 * every legitimately long "thinking" pause (upstream silence is normal while
 * the model reasons), which is a worse failure than the wedge. The reaper below
 * therefore IS the bound for that case: deterministic, TTL-based, and it leaves
 * a locked (genuinely running) turn alone.
 */

export interface RegisteredStream {
  turnId: string
  sessionId: string
  startedAt: number
  lastProgressAt: number
  /** Abort the model call behind this turn (best effort). */
  abort: () => void
  /** Force the turn's buffer closed with a synthesized terminal frame. */
  reap: (reason: string, status?: 'failed' | 'aborted') => void
}

export interface StreamRegistryOptions {
  /** True while the session still holds the gateway's turn lock. */
  isTurnLocked: (sessionId: string) => boolean
  /** How long a turn may make no buffer progress before it is an orphan. */
  orphanTtlMs?: number
  /** Clock, for tests. */
  now?: () => number
  /** Where the reaper's loud line goes. */
  log?: (line: string) => void
}

export const DEFAULT_STREAM_ORPHAN_TTL_MS = 10 * 60_000

export class StreamRegistry {
  private readonly streams = new Map<string, RegisteredStream>()
  private readonly opts: StreamRegistryOptions
  private readonly orphanTtlMs: number
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(opts: StreamRegistryOptions) {
    this.opts = opts
    this.orphanTtlMs = opts.orphanTtlMs ?? DEFAULT_STREAM_ORPHAN_TTL_MS
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((line) => console.warn(line))
  }

  /** Every turn currently streaming (live or orphaned). */
  get size(): number {
    return this.streams.size
  }

  register(stream: Omit<RegisteredStream, 'startedAt' | 'lastProgressAt'> & { startedAt?: number }): void {
    const startedAt = stream.startedAt ?? this.now()
    this.streams.set(stream.turnId, {
      turnId: stream.turnId,
      sessionId: stream.sessionId,
      startedAt,
      lastProgressAt: startedAt,
      abort: stream.abort,
      reap: stream.reap,
    })
  }

  /** Record buffer progress, so a quiet-but-working turn keeps its place. */
  touch(turnId: string): void {
    const entry = this.streams.get(turnId)
    if (entry) entry.lastProgressAt = this.now()
  }

  /** The turn ended on its own. Idempotent — a reaped turn is already gone. */
  end(turnId: string): void {
    this.streams.delete(turnId)
  }

  has(turnId: string): boolean {
    return this.streams.has(turnId)
  }

  /**
   * Turns that are real work: still holding their session's turn lock, or
   * having written to their buffer inside the TTL. This — not `size` — is what
   * "busy" means; an orphaned stream is still in `size` until the reaper runs.
   */
  liveCount(now = this.now()): number {
    let live = 0
    for (const entry of this.streams.values()) {
      if (this.isLive(entry, now)) live++
    }
    return live
  }

  /** Whether at least one stream is real work (see `liveCount`). */
  hasLiveStreams(now = this.now()): boolean {
    for (const entry of this.streams.values()) {
      if (this.isLive(entry, now)) return true
    }
    return false
  }

  private isLive(entry: RegisteredStream, now: number): boolean {
    if (this.opts.isTurnLocked(entry.sessionId)) return true
    return now - entry.lastProgressAt < this.orphanTtlMs
  }

  /**
   * Abort and drop every turn that has been quiet past the TTL and no longer
   * holds its session's turn lock. Returns the turn ids that were reaped.
   */
  reapOrphans(now = this.now()): string[] {
    const reaped: string[] = []
    for (const entry of [...this.streams.values()]) {
      if (this.opts.isTurnLocked(entry.sessionId)) continue
      const quietMs = now - entry.lastProgressAt
      if (quietMs < this.orphanTtlMs) continue

      const minutes = Math.round(quietMs / 60_000)
      this.log(
        `[agent-runtime] reaped orphan stream turnId=${entry.turnId} session=${entry.sessionId} ` +
          `quiet=${minutes}m (no turn lock, no buffer progress) — closing the buffer so the runtime can idle`,
      )
      this.streams.delete(entry.turnId)
      try {
        entry.abort()
      } catch (err: any) {
        console.warn(`[agent-runtime] abort of orphaned stream ${entry.turnId} failed: ${err?.message ?? err}`)
      }
      try {
        entry.reap(`stream reaped after ${minutes}m without progress (turn lock released)`)
      } catch (err: any) {
        console.warn(`[agent-runtime] close of orphaned stream ${entry.turnId} failed: ${err?.message ?? err}`)
      }
      reaped.push(entry.turnId)
    }
    return reaped
  }

  /** Drop every entry without touching buffers (shutdown). */
  clear(): void {
    this.streams.clear()
  }

  /**
   * Force-close every stream of one session, whatever it is doing.
   *
   * For an explicit user Stop only. `reapOrphans` deliberately leaves a locked
   * or still-progressing turn alone — that is right for a long tool call, and
   * wrong for a person who pressed Stop: the turn writes a progress frame every
   * 15 s, so its buffer never goes quiet and the orphan TTL never fires (prod:
   * a chat stuck 18 h). A Stop overrides both rules.
   */
  forceReapSession(
    sessionId: string,
    reason: string,
    status: 'failed' | 'aborted' = 'aborted',
    onlyTurnIds?: ReadonlySet<string>,
  ): string[] {
    const reaped: string[] = []
    for (const entry of [...this.streams.values()]) {
      if (entry.sessionId !== sessionId) continue
      // A turn started after the Stop (the user's next message) must survive.
      if (onlyTurnIds && !onlyTurnIds.has(entry.turnId)) continue
      this.log(
        `[agent-runtime] force-reaped stream turnId=${entry.turnId} session=${sessionId} after Stop — ` +
          'writing the terminal frame so the chat is no longer busy',
      )
      this.streams.delete(entry.turnId)
      try {
        entry.abort()
      } catch (err: any) {
        console.warn(`[agent-runtime] abort of stopped stream ${entry.turnId} failed: ${err?.message ?? err}`)
      }
      try {
        entry.reap(reason, status)
      } catch (err: any) {
        console.warn(`[agent-runtime] close of stopped stream ${entry.turnId} failed: ${err?.message ?? err}`)
      }
      reaped.push(entry.turnId)
    }
    return reaped
  }

  /** Whether this session still has a live turn in the registry. */
  hasSession(sessionId: string): boolean {
    for (const entry of this.streams.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  /** The turn ids currently streaming for one session. */
  turnIdsFor(sessionId: string): string[] {
    const ids: string[] = []
    for (const entry of this.streams.values()) {
      if (entry.sessionId === sessionId) ids.push(entry.turnId)
    }
    return ids
  }
}
