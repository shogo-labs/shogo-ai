// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Write-ahead journal of a turn's raw SSE frames (SHO-274).
 *
 * The bar for this card is zero loss: *a frame reaches the client only after it
 * is durable in the database.* Without the journal the only durable copy of a
 * streamed reply was the 2 s snapshot of `trackUsageFromStream`, so a process
 * that died inside that window took the last second of the reply with it — and
 * a process killed in the first second took all of it.
 *
 * The relay writes here before it forwards anything. That costs one insert per
 * batch (milliseconds, and batches coalesce while an insert is in flight), and
 * it makes "what the person has seen" a subset of "what is stored" for every
 * way this platform dies: a runtime pod evicted mid-turn, the API pod killed,
 * or both on one desktop.
 *
 * Append-only. Rows are deleted when their turn completes, after a recovery has
 * rebuilt the row, and by a 48 h sweep for anything left over.
 */
import { prisma } from '../lib/prisma'

/** How long a turn's frames are kept if nothing else removes them. */
export const TURN_FRAME_RETENTION_MS = 48 * 60 * 60_000

/** Backoff between journal insert attempts. Summed, this holds the frames for
 * ~1.6 s before the relay gives up and forwards anyway. */
const RETRY_DELAYS_MS = [50, 150, 400, 1_000]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether a failed insert is worth retrying.
 *
 * A transient database hiccup (locked SQLite, a dropped Postgres connection, a
 * pooler timeout) is; a code defect — or a client that has no such model — never
 * will be, and retrying it would stall every stream for the whole retry budget.
 */
function isTransient(error: any): boolean {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'P1001' || code === 'P1002' || code === 'P1017' || code === 'P2024') return true
  const message = String(error?.message ?? '')
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|ECONNRESET|ETIMEDOUT|connection (closed|terminated)/i.test(message)
}

const text = (frame: Uint8Array | string): string =>
  typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8')

/**
 * Appends one batch of frames for a turn, in order.
 *
 * Idempotent per `seq`: the retry after an insert that actually committed hits
 * the unique key and is treated as success, so a flaky connection cannot write
 * the same frames twice (which would duplicate the reply on replay).
 *
 * Returns false when the frames could not be written. The caller logs once and
 * forwards anyway: a database outage must not freeze the person's stream, and
 * the gap is visible in the journal log rather than silent.
 */
export async function appendTurnFrames(sessionId: string, turnId: string, seq: number, frames: Array<Uint8Array | string>): Promise<boolean> {
  if (frames.length === 0) return true
  const data = frames.map(text).join('')
  if (!data) return true
  let delays = [...RETRY_DELAYS_MS]
  for (;;) {
    try {
      await prisma.chatTurnFrame.create({ data: { sessionId, turnId, seq, data } })
      return true
    } catch (error: any) {
      // Already written by the attempt whose response we never saw.
      if (error?.code === 'P2002') return true
      const retryable = isTransient(error)
      const delay = retryable ? delays.shift() : undefined
      if (delay === undefined) {
        console.warn(`[ChatTurnJournal] JOURNAL WRITE FAILED session=${sessionId} turn=${turnId} seq=${seq}:`, error?.message ?? error)
        return false
      }
      await sleep(delay)
    }
  }
}

/**
 * A turn's frames in order, as the raw text the client received.
 *
 * Batches are concatenated: an SSE frame can be split across chunks, and the
 * replay must be byte-identical to what was streamed for the parser to rebuild
 * the same row.
 */
export async function readTurnFrames(turnId: string): Promise<string[]> {
  const rows = await prisma.chatTurnFrame
    .findMany({ where: { turnId }, orderBy: { seq: 'asc' }, select: { data: true } })
    .catch(() => [])
  return rows.map((row) => row.data)
}

/** How much is waiting to be recovered for a turn, without reading it. */
export async function turnFrameCount(turnId: string): Promise<number> {
  return prisma.chatTurnFrame.count({ where: { turnId } }).catch(() => 0)
}

/** Drop a turn's frames: its row is complete, or a recovery consumed them. */
export async function deleteTurnFrames(turnId: string): Promise<number> {
  const { count } = await prisma.chatTurnFrame.deleteMany({ where: { turnId } }).catch(() => ({ count: 0 }))
  return count
}

/**
 * Delete frames nobody can recover any more.
 *
 * A turn that completed deletes its own; this catches the rest — a session
 * deleted mid-turn, a recovery that never ran because the app was closed.
 */
export async function sweepTurnFrames(maxAgeMs: number = TURN_FRAME_RETENTION_MS): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs)
  const { count } = await prisma.chatTurnFrame
    .deleteMany({ where: { createdAt: { lt: cutoff } } })
    .catch(() => ({ count: 0 }))
  if (count > 0) console.log(`[ChatTurnJournal] Swept ${count} journal frame(s) older than ${Math.round(maxAgeMs / 3_600_000)}h`)
  return count
}

/**
 * The relay's handle on one turn's journal.
 *
 * `append` never throws and never blocks longer than the retry budget, so the
 * relay loop can await it on every read: while an insert is in flight, later
 * chunks accumulate and go out together as one batch.
 */
export class TurnJournalWriter {
  private seq = 0
  private failed = false
  private batches = 0

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
  ) {}

  /**
   * Write these frames and resolve once they are durable.
   *
   * `false` means the last write failed; the caller forwards anyway (see
   * `appendTurnFrames`) and this writer stops trying to log the same failure.
   */
  async append(frames: Array<Uint8Array | string>): Promise<boolean> {
    const seq = this.seq++
    this.batches++
    const ok = await appendTurnFrames(this.sessionId, this.turnId, seq, frames)
    if (!ok && !this.failed) {
      this.failed = true
      console.warn(`[ChatTurnJournal] Journalling disabled for turn ${this.turnId} after a failed insert`)
    }
    return ok
  }

  /** Frames written, for the stream's closing log line. */
  get written(): number {
    return this.batches
  }
}
