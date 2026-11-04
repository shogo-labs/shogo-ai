// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop half of the cloud → desktop sync for hosted workspaces (SHO-285).
 *
 * The pusher sends this desktop's writes up. The puller brings the cloud's
 * writes down: it reads `GET /api/machines/:id/changes?cursor=N` every couple
 * of seconds and applies each row last-writer-wins by `updatedAt` (append-only
 * rows — messages, tool logs — have none and are simply written). Ids are the
 * same on both sides, so nothing is mapped.
 *
 * A row applied here is not pushed back up: the change-log entries its write
 * produced are removed right after the apply. A queued turn that arrives (a
 * message sent from the cloud while this desktop was offline) is handed to the
 * local queue dispatcher, which runs it here.
 */

import { incomingWins } from './ingest-lww'
import { CHANGE_TABLE } from './triggers'
import { delegateName } from './models'
import { foldOrphanedPersonalRoot } from './personal-workspace'

const DEFAULT_INTERVAL_MS = 2_000
const IDLE_INTERVAL_MS = 2_000
const ERROR_BACKOFF_MS = 15_000
const AUTH_BACKOFF_MS = 10 * 60_000
/**
 * Refusals of the device key tolerated before the puller parks for
 * `AUTH_BACKOFF_MS`, and the short wait between them.
 *
 * A single 401/403 is not evidence the key is dead: right after a restart the
 * cloud can refuse a request while the desktop is still adopting its identity,
 * and parking for ten minutes then left the desktop with no cloud → desktop
 * sync at all (SHO-301, AC5). The park is only armed once the refusal repeats.
 */
const AUTH_REFUSALS_BEFORE_BLOCK = 3
const AUTH_SETTLE_RETRY_MS = 2_000
const REQUEST_TIMEOUT_MS = 30_000

export interface HostFeedPageWire {
  cursor: number
  more: boolean
  userId: string
  models: Array<{ model: string; rows: Array<Record<string, unknown>> }>
  deletes: Array<{ model: string; recordId: string }>
}

export interface HostSyncPullerOptions {
  prisma: any
  getCloudUrl: () => string
  getApiKey: () => string | null
  getInstanceId: () => string | null | Promise<string | null>
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  intervalMs?: number
  /**
   * The name a folded-in Personal root is filed under (`merged/<device>/`).
   * Same name the adoption path uses, so a merge that happens on the cloud and
   * one that happens at pairing land in the same folder.
   */
  deviceName?: string
  /** Called with the sessions that gained pending queued turns. */
  onQueuedTurns?: (sessionIds: string[]) => void | Promise<void>
}

/** Scalar column names of a model on this client, from Prisma's runtime data model. */
function columnsOf(prisma: any, model: string): Set<string> | null {
  const fields = prisma?._runtimeDataModel?.models?.[model]?.fields
  if (!Array.isArray(fields)) return null
  return new Set(
    fields.filter((field: any) => field.kind === 'scalar' || field.kind === 'enum').map((field: any) => field.name),
  )
}

function listColumnsOf(prisma: any, model: string): Set<string> {
  const fields = prisma?._runtimeDataModel?.models?.[model]?.fields
  if (!Array.isArray(fields)) return new Set()
  return new Set(fields.filter((field: any) => field.isList).map((field: any) => field.name))
}

/** Keep the columns this desktop has; a cloud one version ahead adds columns. */
export function rowForLocal(prisma: any, model: string, row: Record<string, unknown>): Record<string, unknown> {
  const columns = columnsOf(prisma, model)
  const lists = listColumnsOf(prisma, model)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue
    if (columns && !columns.has(key)) continue
    out[key] = lists.has(key) && typeof value === 'string' ? safeParseList(value) : value
  }
  return out
}

function safeParseList(value: string): unknown {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Apply one feed page to the local database. Exported for the tests and the
 * two-process harness; the puller calls it on every page.
 */
export async function applyHostFeedPage(
  prisma: any,
  page: Pick<HostFeedPageWire, 'models' | 'deletes'>,
  log: (line: string) => void = () => {},
  opts: { deviceName?: string } = {},
): Promise<{ applied: number; skipped: number; deleted: number; queuedSessions: string[] }> {
  let applied = 0
  let skipped = 0
  let deleted = 0
  const touched: Array<{ model: string; recordId: string }> = []
  const queuedSessions = new Set<string>()

  const before = await prisma[delegateName('MachineSyncChange')]
    ?.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } })
    .catch(() => null)
  const fromSeq: number = before?.seq ?? 0

  for (const entry of page.models) {
    const delegate = prisma[delegateName(entry.model)]
    if (!delegate) continue
    const ids = entry.rows.map((row) => String(row.id))
    const existing = new Map<string, Record<string, unknown>>(
      ((await delegate.findMany({ where: { id: { in: ids } } }).catch(() => [])) as Array<Record<string, unknown>>).map(
        (row) => [String(row.id), row],
      ),
    )
    for (const raw of entry.rows) {
      const id = String(raw.id)
      const current = existing.get(id)
      // Another person on this desktop's own user row is never overwritten; a
      // teammate's `User` row the desktop lacks is created so messages resolve.
      if (entry.model === 'User' && current) {
        skipped++
        continue
      }
      if (!incomingWins(current, raw)) {
        skipped++
        continue
      }
      const data = rowForLocal(prisma, entry.model, raw)
      try {
        await delegate.upsert({ where: { id }, create: data, update: data })
        applied++
        touched.push({ model: entry.model, recordId: id })
        if (entry.model === 'ChatQueuedMessage' && data.status === 'pending' && typeof data.sessionId === 'string') {
          queuedSessions.add(data.sessionId)
        }
      } catch (err) {
        skipped++
        log(`[HostSync] could not apply ${entry.model}/${id}: ${(err as Error)?.message?.split('\n').pop() ?? err}`)
      }
    }
  }

  for (const entry of page.deletes) {
    const delegate = prisma[delegateName(entry.model)]
    if (!delegate) continue
    try {
      // The cloud's merge of this device's Personal into the account's Personal
      // (SHO-285 Update 2) deletes the duplicate row here, but the duplicate's
      // root is on *this* disk — the cloud never held those files, so the
      // cloud-side merge moved none of them. Fold the directory into the
      // survivor's `merged/<device>/` before the row goes, or the files are
      // stranded with no row to find them by.
      if (entry.model === 'Workspace') {
        const row = await prisma.workspace
          ?.findUnique({ where: { id: entry.recordId }, select: { kind: true } })
          .catch(() => null)
        if (row?.kind === 'personal') {
          const survivor = await prisma.workspace
            ?.findFirst({ where: { kind: 'personal', NOT: { id: entry.recordId } }, select: { id: true } })
            .catch(() => null)
          if (survivor?.id) {
            const deviceName = opts.deviceName ?? process.env.SHOGO_INSTANCE_NAME ?? 'device'
            const moved = foldOrphanedPersonalRoot(entry.recordId, survivor.id, deviceName)
            if (moved) log(`[HostSync] moved ${moved} file(s) from the merged Personal into merged/${deviceName}`)
          }
        }
      }
      const result = await delegate.deleteMany({ where: { id: entry.recordId } })
      if (result?.count) {
        deleted += result.count
        touched.push({ model: entry.model, recordId: entry.recordId })
      }
    } catch (err) {
      log(`[HostSync] could not delete ${entry.model}/${entry.recordId}: ${(err as Error)?.message ?? err}`)
    }
  }

  // What came from the cloud does not go back up to it.
  if (touched.length) {
    for (let offset = 0; offset < touched.length; offset += 200) {
      const slice = touched.slice(offset, offset + 200)
      const clauses = slice.map(() => '("model" = ? AND "recordId" = ?)').join(' OR ')
      const params = slice.flatMap((row) => [row.model, row.recordId])
      await prisma
        .$executeRawUnsafe(`DELETE FROM "${CHANGE_TABLE}" WHERE "seq" > ? AND (${clauses})`, fromSeq, ...params)
        .catch(() => {})
    }
  }

  return { applied, skipped, deleted, queuedSessions: [...queuedSessions] }
}

export class HostSyncPuller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private ticking = false
  private cursorKey: string | null = null
  private cursor = 0
  private blockedUntil = 0
  /** Consecutive 401/403 answers since the last successful pull. */
  private authRefusals = 0
  lastError: string | null = null
  lastPulledAt: number | null = null

  constructor(private readonly opts: HostSyncPullerOptions) {}

  /** What Settings and a support handoff read: why the feed is not moving. */
  get status(): { lastError: string | null; blockedUntil: number; authRefusals: number; lastPulledAt: string | null } {
    return {
      lastError: this.lastError,
      blockedUntil: this.blockedUntil,
      authRefusals: this.authRefusals,
      lastPulledAt: this.lastPulledAt ? new Date(this.lastPulledAt).toISOString() : null,
    }
  }

  private get log(): (line: string) => void {
    return this.opts.log ?? (() => {})
  }

  start(): void {
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick().then((delay) => this.schedule(delay))
    }, delayMs)
  }

  /** The cursor lives in `MachineSyncState.metadata`-free storage: a tiny row per instance. */
  private async loadCursor(instanceId: string): Promise<number> {
    const key = `host-feed:${instanceId}`
    if (this.cursorKey === key) return this.cursor
    const row = await this.opts.prisma.machineSyncState
      .findUnique({ where: { instanceId: key }, select: { cursor: true } })
      .catch(() => null)
    this.cursorKey = key
    this.cursor = Number(row?.cursor ?? 0)
    return this.cursor
  }

  private async saveCursor(instanceId: string, cursor: number): Promise<void> {
    const key = `host-feed:${instanceId}`
    this.cursor = cursor
    await this.opts.prisma.machineSyncState
      .upsert({
        where: { instanceId: key },
        create: { instanceId: key, epoch: 'host-feed', cursor, enabled: true },
        update: { cursor },
      })
      .catch(() => {})
  }

  /** One pull. Returns the delay before the next one. Never throws. */
  async tick(): Promise<number> {
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS
    if (this.stopped || this.ticking) return interval
    if (Date.now() < this.blockedUntil) return this.blockedUntil - Date.now()
    this.ticking = true
    try {
      const apiKey = this.opts.getApiKey()
      const instanceId = await this.opts.getInstanceId()
      if (!apiKey || !instanceId) return interval
      const cursor = await this.loadCursor(instanceId)
      const url = `${this.opts.getCloudUrl().replace(/\/$/, '')}/api/machines/${encodeURIComponent(instanceId)}/changes?cursor=${cursor}`
      const response = await (this.opts.fetchImpl ?? fetch)(url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.status === 401 || response.status === 403) {
        this.authRefusals++
        this.lastError = `feed refused (${response.status})`
        if (this.authRefusals >= AUTH_REFUSALS_BEFORE_BLOCK) {
          this.blockedUntil = Date.now() + AUTH_BACKOFF_MS
          this.log(
            `[HostSync] feed refused the device key ${this.authRefusals} times; retrying in ${AUTH_BACKOFF_MS / 60_000} min`,
          )
          return AUTH_BACKOFF_MS
        }
        this.log(`[HostSync] feed refused the device key (${response.status}); retrying in ${AUTH_SETTLE_RETRY_MS / 1000}s`)
        return AUTH_SETTLE_RETRY_MS
      }
      if (!response.ok) {
        this.lastError = `feed ${response.status}`
        return ERROR_BACKOFF_MS
      }
      const page = (await response.json()) as HostFeedPageWire
      if (page.models?.length || page.deletes?.length) {
        const result = await applyHostFeedPage(this.opts.prisma, page, this.log, { deviceName: this.opts.deviceName })
        if (result.applied || result.deleted) {
          this.log(`[HostSync] pulled ${result.applied} row(s), ${result.deleted} delete(s) from the cloud`)
        }
        if (result.queuedSessions.length) await this.opts.onQueuedTurns?.(result.queuedSessions)
      }
      if (typeof page.cursor === 'number' && page.cursor > cursor) await this.saveCursor(instanceId, page.cursor)
      this.authRefusals = 0
      this.lastError = null
      this.lastPulledAt = Date.now()
      return page.more ? 0 : IDLE_INTERVAL_MS
    } catch (err) {
      this.lastError = (err as Error)?.message ?? String(err)
      return ERROR_BACKOFF_MS
    } finally {
      this.ticking = false
    }
  }
}
