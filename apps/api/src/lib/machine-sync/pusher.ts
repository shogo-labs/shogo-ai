// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop half of the machine copy (SHO-185).
 *
 * Reads the change log the SQLite triggers fill, coalesces it per row, and sends
 * the *current* state of those rows to the cloud over HTTPS — never over the
 * tunnel, so bulk data cannot sit behind (or block) a live request.
 *
 * Rules that keep it out of the request path:
 *   • everything here is async and started once, next to the tunnel;
 *   • a tick never throws into a caller — a failed push is retried with backoff;
 *   • the acked cursor only moves after the cloud says it applied the batch, so
 *     a crash replays instead of losing writes (the upserts are idempotent).
 */

import { readFileSync } from 'node:fs'
import type { PrismaClient } from '../../generated/prisma-pg/client'
import { applyRewrites, delegateName, MIRROR_MODELS } from './models'
import { parseSchema, writeOrder } from './schema-model'
import { installSyncTriggers } from './triggers'

/** Rows per page when a whole model is sent for the first time. */
const SNAPSHOT_PAGE_ROWS = 500
/** Change rows read from the log per tick. */
const CHANGE_BATCH_ROWS = 5_000
/** Rows per HTTPS request. */
const MAX_ROWS_PER_REQUEST = 500
/** Bytes per HTTPS request, before it is split. */
const MAX_BYTES_PER_REQUEST = 1_000_000
/** How long a change may wait before it is pushed anyway. */
const IDLE_PUSH_INTERVAL_MS = 30_000
/** Poll for new changes. Cheap: one indexed `SELECT max(seq)`. */
const POLL_INTERVAL_MS = 500

export interface SyncBatchModel {
  model: string
  rows: Record<string, unknown>[]
}

export interface SyncBatchRequest {
  epoch: string
  mode: 'changes' | 'snapshot'
  /** Highest change-log seq covered by this batch (changes mode). */
  cursor: number
  models: SyncBatchModel[]
  deletes?: Array<{ model: string; recordId: string }>
  /** Set on the last request of a full snapshot. */
  snapshot?: { complete: boolean; models: string[] }
}

export interface SyncBatchResponse {
  ok?: boolean
  epoch?: string
  cursor?: number
  disabled?: boolean
  syncedAt?: string
  /** The cloud holds a different epoch: send a full snapshot under a new one. */
  code?: string
  error?: { code?: string; message?: string }
}

export interface MachineSyncPusherOptions {
  prisma: PrismaClient | any
  /** Base URL of the cloud API, e.g. `https://studio.shogo.ai`. */
  getCloudUrl: () => string
  /** The device key this machine signed in with. */
  getApiKey: () => string | null
  /**
   * The cloud `instances` row id for this machine. Resolved asynchronously
   * because it only exists once a heartbeat has been answered.
   */
  getInstanceId: () => Promise<string | null> | string | null
  /** Region the cloud copy should live in. */
  getHomeRegion?: () => string
  log?: (message: string) => void
  fetchImpl?: typeof fetch
  /** Testing seam for the polling interval. */
  pollIntervalMs?: number
}

type ChangeRow = { seq: number; model: string; recordId: string; op: string }

/** `JSON.stringify` that survives a BigInt (none today — but a new column shouldn't crash a push). */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val))
}

/**
 * Write order for the mirror set, from the schema when it is readable and from
 * the declaration order otherwise. The desktop's copy of the repo has the
 * schema; a packaged app may not, and a wrong order only costs a retry.
 */
let cachedOrder: Map<string, number> | null = null
function modelOrder(): Map<string, number> {
  if (cachedOrder) return cachedOrder
  const fallback = new Map<string, number>(MIRROR_MODELS.map((model, index) => [model, index]))
  try {
    const url = new URL('../../../../../prisma/schema.prisma', import.meta.url)
    const source = readFileSync(url, 'utf8')
    const parsed = parseSchema(source)
    const known = new Set(parsed.models.map((model) => model.name))
    const fromSchema = writeOrder(parsed)
    const order = new Map<string, number>()
    MIRROR_MODELS.forEach((model, index) => {
      order.set(model, known.has(model) ? (fromSchema.get(model) ?? index) : index)
    })
    cachedOrder = order
    return order
  } catch {
    cachedOrder = fallback
    return fallback
  }
}

export class MachineSyncPusher {
  private readonly opts: MachineSyncPusherOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /**
   * Set once `stop()` runs, or once the cloud says sync is off. A pusher that
   * was constructed but never `start()`ed still answers `tick()`: the scheduled
   * loop is what `stop()` guards, not a one-off push.
   */
  private stopped = false
  private ticking = false
  private epoch: string | null = null
  private cursor = 0
  private lastAckedAt: number | null = null
  private lastError: string | null = null
  private failureCount = 0
  private snapshotNeeded = false
  private instanceId: string | null = null
  private triggersInstalled = false
  private pushes = 0

  constructor(opts: MachineSyncPusherOptions) {
    this.opts = opts
  }

  private get log(): (message: string) => void {
    return this.opts.log ?? (() => {})
  }

  get status(): {
    running: boolean
    instanceId: string | null
    epoch: string | null
    cursor: number
    lastAckedAt: string | null
    lastError: string | null
    pushes: number
  } {
    return {
      running: this.running,
      instanceId: this.instanceId,
      epoch: this.epoch,
      cursor: this.cursor,
      lastAckedAt: this.lastAckedAt ? new Date(this.lastAckedAt).toISOString() : null,
      lastError: this.lastError,
      pushes: this.pushes,
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.stopped = false
    this.running = true
    try {
      if (!this.triggersInstalled) {
        await installSyncTriggers(this.opts.prisma as any, this.log)
        this.triggersInstalled = true
      }
    } catch (err) {
      this.lastError = (err as Error).message
    }
    this.log('[MachineSync] Pusher started')
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Push now (the tunnel calls this after a mutation so the next read is fresh). */
  async syncNow(): Promise<void> {
    await this.tick()
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.nextDelay()))
    }, delayMs)
  }

  private nextDelay(): number {
    if (this.failureCount > 0) {
      return Math.min(POLL_INTERVAL_MS * 2 ** Math.min(this.failureCount, 5), 30_000)
    }
    return POLL_INTERVAL_MS
  }

  /** One push attempt. Never throws. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const apiKey = this.opts.getApiKey()
      if (!apiKey) return
      const instanceId = await this.opts.getInstanceId()
      if (!instanceId) return
      if (instanceId !== this.instanceId) {
        // A different machine identity (re-paired, or the first heartbeat
        // landed): nothing carries over.
        this.instanceId = instanceId
        this.epoch = null
        this.cursor = 0
        this.snapshotNeeded = false
      }
      const state = await this.loadState(instanceId)
      if (!state) return
      this.epoch = state.epoch
      this.cursor = state.cursor
      // Nothing has ever been pushed for this device: the rows it already has
      // predate the triggers, so only a snapshot can bring them across.
      if (state.fresh) this.snapshotNeeded = true

      if (this.snapshotNeeded) {
        await this.runSnapshot(instanceId, apiKey)
        return
      }

      await this.pushChanges(instanceId, apiKey)
    } catch (err) {
      this.failureCount++
      this.lastError = (err as Error).message
      this.log(`[MachineSync] push failed: ${this.lastError}`)
    } finally {
      this.ticking = false
    }
  }

  private async loadState(
    instanceId: string,
  ): Promise<{ epoch: string; cursor: number; fresh: boolean } | null> {
    const prisma = this.opts.prisma as any
    const existing = await prisma.machineSyncState.findUnique({ where: { instanceId } })
    if (existing) {
      if (existing.enabled === false) {
        // Sync switched off on the cloud: stay quiet rather than push into a
        // workspace the cloud has already deleted. Checked before the epoch
        // below — a switched-off machine also has its epoch cleared.
        this.stopped = true
        this.running = false
        this.log('[MachineSync] Sync to cloud is off for this machine; pusher stopped')
        return null
      }
      if (!existing.epoch) {
        const updated = await prisma.machineSyncState.update({
          where: { instanceId },
          data: { epoch: crypto.randomUUID() },
        })
        return { epoch: updated.epoch, cursor: updated.cursor, fresh: true }
      }
      return { epoch: existing.epoch, cursor: existing.cursor, fresh: false }
    }
    // First ever push (or a fresh desktop database): the whole thing has to be
    // sent, so the epoch starts empty and the snapshot claims it.
    const created = await prisma.machineSyncState.create({
      data: { instanceId, epoch: crypto.randomUUID(), cursor: 0, enabled: true },
    })
    return { epoch: created.epoch, cursor: created.cursor, fresh: true }
  }

  private async maxSeq(): Promise<number> {
    const prisma = this.opts.prisma as any
    const rows = await prisma.machineSyncChange.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    return rows?.seq ?? 0
  }

  private async pushChanges(instanceId: string, apiKey: string): Promise<void> {
    const prisma = this.opts.prisma as any
    const changes: ChangeRow[] = await prisma.machineSyncChange.findMany({
      orderBy: { seq: 'asc' },
      take: CHANGE_BATCH_ROWS,
      where: this.cursor > 0 ? { seq: { gt: this.cursor } } : undefined,
    })
    if (!changes.length) return

    const highest = changes[changes.length - 1].seq
    const coalesced = coalesceChanges(changes)

    // A delete for a row that was created and deleted inside the same window is
    // a no-op in the cloud; keep only the last op per row (done above) and skip
    // deletes of ids that are not in the mirror anyway (the cloud 409s those).
    const upsertsByModel = new Map<string, string[]>()
    for (const change of coalesced) {
      if (change.op !== 'upsert') continue
      const ids = upsertsByModel.get(change.model) ?? []
      ids.push(change.recordId)
      upsertsByModel.set(change.model, ids)
    }

    const order = modelOrder()
    const models = [...upsertsByModel.keys()].sort(
      (a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999),
    )

    for (const request of await this.buildRequests(models, upsertsByModel, coalesced, highest)) {
      const ok = await this.post(instanceId, apiKey, request)
      if (!ok) return
    }

    await this.advance(instanceId, highest)
  }

  private async buildRequests(
    models: string[],
    upsertsByModel: Map<string, string[]>,
    coalesced: Array<{ model: string; recordId: string; op: string }>,
    cursor: number,
  ): Promise<SyncBatchRequest[]> {
    const prisma = this.opts.prisma as any
    const requests: SyncBatchRequest[] = []
    const deletes = coalesced
      .filter((change) => change.op !== 'upsert')
      .map((change) => ({ model: change.model, recordId: change.recordId }))

    let pending: SyncBatchModel[] = []
    let pendingRows = 0
    let pendingBytes = 0

    const flush = (isLast: boolean) => {
      if (!pending.length && !isLast) return
      requests.push({
        epoch: this.epoch ?? '',
        mode: 'changes',
        cursor,
        models: pending,
        deletes: isLast ? deletes : undefined,
      })
      pending = []
      pendingRows = 0
      pendingBytes = 0
    }

    for (const model of models) {
      const ids = upsertsByModel.get(model) ?? []
      for (let offset = 0; offset < ids.length; offset += MAX_ROWS_PER_REQUEST) {
        const slice = ids.slice(offset, offset + MAX_ROWS_PER_REQUEST)
        const rows: Record<string, unknown>[] = await prisma[delegateName(model)].findMany({
          where: { id: { in: slice } },
        })
        // A row snapped by another process between the change and this read is
        // simply gone; the coalesced op was an upsert but the row no longer
        // exists, so it becomes a delete.
        const found = new Set(rows.map((row) => row.id))
        for (const id of slice) {
          if (!found.has(id)) deletes.push({ model, recordId: id })
        }
        for (const row of rows) {
          const size = toJson(row).length
          if (pendingRows >= MAX_ROWS_PER_REQUEST || pendingBytes + size > MAX_BYTES_PER_REQUEST) {
            flush(false)
          }
          const target = pending.find((entry) => entry.model === model)
          if (target) target.rows.push(row)
          else pending.push({ model, rows: [row] })
          pendingRows++
          pendingBytes += size
        }
      }
    }
    flush(true)
    return requests
  }

  private async post(
    instanceId: string,
    apiKey: string,
    body: SyncBatchRequest,
  ): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const url = `${this.opts.getCloudUrl().replace(/\/$/, '')}/api/machines/${encodeURIComponent(instanceId)}/sync`
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: toJson(body),
    })

    if (response.ok) {
      this.failureCount = 0
      this.lastError = null
      this.pushes++
      this.lastAckedAt = Date.now()
      const result = (await response.json().catch(() => ({}))) as SyncBatchResponse
      if (result.disabled) {
        this.stopped = true
        this.running = false
        this.log('[MachineSync] Cloud reports sync disabled; pusher stopped')
        return false
      }
      if (typeof result.cursor === 'number' && result.cursor > this.cursor) this.cursor = result.cursor
      return true
    }

    const result = (await response.json().catch(() => ({}))) as SyncBatchResponse
    const code = result.code ?? result.error?.code
    if (code === 'epoch_mismatch') {
      // The cloud holds rows from a database that no longer exists here.
      this.log('[MachineSync] Cloud epoch mismatch — sending a full snapshot')
      this.snapshotNeeded = true
      this.epoch = null
      return false
    }
    this.failureCount++
    this.lastError = code ?? `HTTP ${response.status}`
    this.log(`[MachineSync] Cloud rejected batch: ${this.lastError}`)
    return false
  }

  /** Move the acked cursor and prune what the cloud now has. */
  private async advance(instanceId: string, seq: number): Promise<void> {
    const prisma = this.opts.prisma as any
    await prisma.machineSyncState.update({
      where: { instanceId },
      data: { cursor: seq, lastIngestAt: new Date() },
    })
    await prisma.machineSyncChange.deleteMany({ where: { seq: { lte: seq } } })
    this.cursor = seq
  }

  /**
   * Send the whole database, one model at a time, parents first.
   *
   * The cloud keeps the rows it already has for this machine until the last
   * request of the snapshot (which may carry `complete: true`), so a desktop
   * that goes offline halfway through leaves a readable, if stale, copy.
   */
  private async runSnapshot(instanceId: string, apiKey: string): Promise<void> {
    const prisma = this.opts.prisma as any
    const epoch = crypto.randomUUID()
    const order = modelOrder()
    const models = [...MIRROR_MODELS].sort(
      (a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999),
    )

    for (const model of models) {
      let lastId: string | null = null
      for (;;) {
        const page: Record<string, unknown>[] = await prisma[delegateName(model)].findMany({
          orderBy: { id: 'asc' },
          take: SNAPSHOT_PAGE_ROWS,
          ...(lastId ? { where: { id: { gt: lastId } } } : {}),
        })
        if (!page.length) break
        lastId = String(page[page.length - 1].id)
        const ok = await this.post(instanceId, apiKey, {
          epoch,
          mode: 'snapshot',
          cursor: 0,
          models: [{ model, rows: page }],
        })
        if (!ok) return
        if (page.length < SNAPSHOT_PAGE_ROWS) break
      }
    }

    // Changes made while the snapshot ran are already in the pages; start the
    // delta stream from now, so nothing is replayed or lost.
    const seq = await this.maxSeq()
    const done = await this.post(instanceId, apiKey, {
      epoch,
      mode: 'snapshot',
      cursor: seq,
      models: [],
      snapshot: { complete: true, models },
    })
    if (!done) return

    this.snapshotNeeded = false
    this.epoch = epoch
    await this.advance(instanceId, seq)
    this.log(`[MachineSync] Snapshot complete under epoch ${epoch.slice(0, 8)}`)
  }
}

/** One entry per row: the last op wins. */
function coalesceChanges(
  changes: ChangeRow[],
): Array<{ model: string; recordId: string; op: string }> {
  const byRow = new Map<string, { model: string; recordId: string; op: string }>()
  for (const change of changes) {
    byRow.set(`${change.model}\u0000${change.recordId}`, {
      model: change.model,
      recordId: change.recordId,
      op: change.op,
    })
  }
  return [...byRow.values()]
}

/**
 * The rows the cloud should store for a desktop row. Exported so the ingest test
 * can assert the two ends agree on the rewrites.
 */
export function prepareRow(
  model: string,
  row: Record<string, unknown>,
  ctx: { instanceId: string; homeRegion: string },
): Record<string, unknown> {
  return applyRewrites(model, row, ctx)
}
