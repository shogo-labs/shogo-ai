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

/**
 * Hard ceiling on the journal, whatever its age (SHO-482).
 *
 * Retention alone is not a bound: a desktop that wrote 8.6M rows in two days
 * had every one of them inside the 48 h window at boot. The cap is what stops
 * the table from growing without limit when the writer runs away.
 */
export const MAX_TURN_FRAMES = 200_000

/** Rows per delete in any sweep. Large enough to make progress, small enough
 * that one batch never blocks the event loop for long. */
export const TURN_FRAME_SWEEP_BATCH = 5_000

/** Batches one tick may run before it leaves the rest for the next one. */
export const TURN_FRAME_SWEEP_MAX_BATCHES = 100

/** Wall-clock budget of one sweep call, between batches. */
export const TURN_FRAME_SWEEP_BUDGET_MS = 2_000

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
  try {
    if (!prisma.chatTurnFrame) return []
    const rows = await prisma.chatTurnFrame.findMany({
      where: { turnId },
      orderBy: { seq: 'asc' },
      select: { data: true },
    })
    return rows.map((row) => row.data)
  } catch {
    return []
  }
}

/** How much is waiting to be recovered for a turn, without reading it. */
export async function turnFrameCount(turnId: string): Promise<number> {
  try {
    if (!prisma.chatTurnFrame) return 0
    return await prisma.chatTurnFrame.count({ where: { turnId } })
  } catch {
    return 0
  }
}

/** Drop a turn's frames: its row is complete, or a recovery consumed them. */
export async function deleteTurnFrames(turnId: string): Promise<number> {
  try {
    if (!prisma.chatTurnFrame) return 0
    const { count } = await prisma.chatTurnFrame.deleteMany({ where: { turnId } })
    return count
  } catch {
    return 0
  }
}

export interface TurnFrameSweepOptions {
  /** Rows per select+delete. Defaults to `TURN_FRAME_SWEEP_BATCH`. */
  batchSize?: number
  /** Batches to run before leaving the rest for the next tick. */
  maxBatches?: number
  /** Wall-clock budget, checked between batches. */
  budgetMs?: number
}

/**
 * Turns whose frames must survive any sweep.
 *
 * A live turn is still appending, and its recovery reads the frames it already
 * has, so deleting them would lose the only durable copy of that reply. The
 * window is small (they are being written right now), which is why this is one
 * cheap query per sweep rather than a join on every batch.
 */
async function liveTurnIds(): Promise<string[]> {
  const rows = await prisma.chatSession
    .findMany({ where: { activeTurnId: { not: null } }, select: { activeTurnId: true } })
    .catch(() => [] as Array<{ activeTurnId: string | null }>)
  return rows.map((row) => row.activeTurnId).filter((id): id is string => !!id)
}

/** Hand the event loop a macrotask, so HTTP requests are served between
 * batches. A microtask would not do: it never leaves the current tick. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Delete, in batches, every frame at or before `cutoff` that no live turn owns.
 *
 * A single `deleteMany` over millions of rows blocks the event loop for about a
 * minute on the synchronous desktop SQLite adapter, which is long enough for the
 * health check to give up and kill the API — so the next launch repeated it
 * (SHO-482). Selecting ids and deleting them in small batches keeps the process
 * answering: five thousand rows per delete is milliseconds, and the loop yields
 * between batches.
 *
 * Keyset-free on purpose — `id` is portable, `rowid` is not. Stops when a batch
 * comes back short (nothing left), when the batch budget is spent, or when the
 * wall-clock budget is. Whatever is left belongs to the next tick.
 */
async function deleteFrameBatches(
  cutoff: Date,
  opts: Required<TurnFrameSweepOptions>,
  live: string[],
): Promise<number> {
  const startedAt = Date.now()
  let deleted = 0
  for (let batch = 0; batch < opts.maxBatches; batch++) {
    if (batch > 0 && Date.now() - startedAt >= opts.budgetMs) break
    const rows = await prisma.chatTurnFrame.findMany({
      where: {
        createdAt: { lte: cutoff },
        ...(live.length ? { turnId: { notIn: live } } : {}),
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: opts.batchSize,
    })
    if (rows.length === 0) break
    const { count } = await prisma.chatTurnFrame
      .deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
      .catch(() => ({ count: 0 }))
    deleted += count
    // A short batch means the filter is exhausted; anything under the cutoff is
    // already gone, so there is nothing to come back for.
    if (rows.length < opts.batchSize) break
    await yieldToEventLoop()
  }
  return deleted
}

function sweepOptions(opts: TurnFrameSweepOptions = {}): Required<TurnFrameSweepOptions> {
  return {
    batchSize: Math.max(1, opts.batchSize ?? TURN_FRAME_SWEEP_BATCH),
    maxBatches: Math.max(1, opts.maxBatches ?? TURN_FRAME_SWEEP_MAX_BATCHES),
    budgetMs: Math.max(0, opts.budgetMs ?? TURN_FRAME_SWEEP_BUDGET_MS),
  }
}

/**
 * Delete frames nobody can recover any more.
 *
 * A turn that completed deletes its own; this catches the rest — a session
 * deleted mid-turn, a recovery that never ran because the app was closed.
 *
 * Never called during boot any more: a backlog that large is swept by the
 * background worker, after the API is healthy (SHO-482).
 */
export async function sweepTurnFrames(
  maxAgeMs: number = TURN_FRAME_RETENTION_MS,
  opts: TurnFrameSweepOptions = {},
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs)
  const deleted = await deleteFrameBatches(cutoff, sweepOptions(opts), await liveTurnIds())
  if (deleted > 0) console.log(`[ChatTurnJournal] Swept ${deleted} journal frame(s) older than ${Math.round(maxAgeMs / 3_600_000)}h`)
  return deleted
}

/**
 * Trim the journal back to `MAX_TURN_FRAMES`, newest rows kept.
 *
 * The boundary is found with one index walk — the `createdAt` of the cap-th
 * newest row — instead of a `COUNT(*)`, so a runaway writer costs a delete, not
 * a full scan on every tick. Logged once per trim, so the runaway is visible in
 * `main.log` rather than inferred from a large database file.
 */
export async function trimTurnFramesToCap(
  max: number = MAX_TURN_FRAMES,
  opts: TurnFrameSweepOptions = {},
): Promise<number> {
  const boundary = await prisma.chatTurnFrame
    .findFirst({ orderBy: { createdAt: 'desc' }, skip: max, select: { createdAt: true } })
    .catch(() => null)
  if (!boundary) return 0
  const deleted = await deleteFrameBatches(boundary.createdAt, sweepOptions(opts), await liveTurnIds())
  if (deleted > 0) console.log(`[ChatTurnJournal] Cap trimmed ${deleted} frame(s)`)
  return deleted
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
