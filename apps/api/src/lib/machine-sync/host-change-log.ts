// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cloud's change feed for hosted workspaces (SHO-285).
 *
 * A hosted workspace's rows live in both databases. The desktop → cloud half
 * is the pusher (SQLite triggers → `MachineSyncChange` → `POST /sync`). This is
 * the other half: every write the cloud makes to a synced row of a hosted
 * workspace appends a `HostSyncChange`, and the desktop pulls them by cursor
 * (`GET /api/machines/:id/changes`).
 *
 * It sits on the Prisma client as a query extension, so a route, a service or
 * a worker that writes a card, a message or a session is covered without
 * knowing any of this — the same "derive it once at the insert point" rule as
 * mentions (SHO-69). Two boundaries:
 *
 *   • Writes made by ingest itself run inside `withoutHostChangeLog`: those rows
 *     came *from* the desktop and must not be fed back to it.
 *   • Nested relation writes (`create: { messages: { create: […] } }`) are not
 *     seen by a query extension; only the top-level row is logged. The synced
 *     models are written flat today.
 *
 * Costs nothing until a desktop hosts a workspace: the hosted-id set is read
 * once per `HOSTED_TTL_MS`, and an empty set skips every lookup.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isMirroredModel } from './models'
import { WorkspaceResolver, loadMetadata } from './ingest'

const suppressed = new AsyncLocalStorage<boolean>()

/** Run `fn` without logging its writes (ingest of rows that came from a desktop). */
export function withoutHostChangeLog<T>(fn: () => Promise<T>): Promise<T> {
  return suppressed.run(true, fn)
}

const HOSTED_TTL_MS = Math.max(1_000, Number(process.env.SHOGO_HOSTED_CHANGELOG_TTL_MS ?? 10_000) || 10_000)
/** Rows read back to log one `updateMany`/`deleteMany`; past this the feed is told to resync. */
const MAX_BULK_ROWS = 5_000

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
])

type Change = { workspaceId: string; model: string; recordId: string; op: 'upsert' | 'delete' }

function delegate(db: any, model: string): any {
  return db[model.charAt(0).toLowerCase() + model.slice(1)]
}

export function createHostChangeLog(base: any) {
  let hosted: { ids: Set<string>; at: number } | null = null
  let inflight: Promise<Set<string>> | null = null

  async function hostedIds(): Promise<Set<string>> {
    if (hosted && Date.now() - hosted.at < HOSTED_TTL_MS) return hosted.ids
    if (inflight) return inflight
    inflight = base.workspace
      .findMany({ where: { hostInstanceId: { not: null } }, select: { id: true } })
      .then((rows: Array<{ id: string }>) => {
        const ids = new Set(rows.map((row) => row.id))
        hosted = { ids, at: Date.now() }
        return ids
      })
      .catch(() => new Set<string>())
      .finally(() => {
        inflight = null
      })
    return inflight!
  }

  function scopeSelect(model: string): Record<string, true> {
    const select: Record<string, true> = { id: true }
    for (const column of WorkspaceResolver.scopeColumns(model)) select[column] = true
    return select
  }

  async function changesFor(
    model: string,
    rows: Array<Record<string, unknown>>,
    op: Change['op'],
    ids: Set<string>,
  ): Promise<Change[]> {
    const resolver = new WorkspaceResolver(base)
    const columns = WorkspaceResolver.scopeColumns(model)
    const out: Change[] = []
    for (const row of rows) {
      const recordId = typeof row?.id === 'string' ? row.id : null
      if (!recordId) continue
      const complete = columns.every((column) => column in row)
      const workspaceId = complete
        ? await resolver.ofRow(model, row)
        : await resolver.ofId(model, recordId)
      if (workspaceId && ids.has(workspaceId)) out.push({ workspaceId, model, recordId, op })
    }
    return out
  }

  async function record(changes: Change[]): Promise<void> {
    if (!changes.length) return
    await base.hostSyncChange.createMany({ data: changes })
  }

  async function around(params: {
    model: string
    operation: string
    args: any
    query: (args: any) => Promise<any>
  }): Promise<any> {
    const { model, operation, query } = params
    let args = params.args
    if (!model || !WRITE_OPS.has(operation) || !isMirroredModel(model) || model === 'User' || suppressed.getStore()) {
      return query(args)
    }
    const ids = await hostedIds()
    if (!ids.size) return query(args)

    const table = delegate(base, model)
    let before: Array<Record<string, unknown>> = []
    try {
      if (operation === 'delete') {
        const row = await table.findUnique({ where: args.where, select: scopeSelect(model) })
        before = row ? [row] : []
      } else if (operation === 'deleteMany' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
        before = await table.findMany({ where: args?.where ?? {}, select: scopeSelect(model), take: MAX_BULK_ROWS })
      } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
        // Ids are filled in here so the rows can be named in the feed; a
        // synced model's id is always a String the caller may choose.
        const meta = loadMetadata().get(model)
        const idField = meta?.model.fields.find((field) => field.isId)
        if (idField?.typeName === 'String') {
          const data = Array.isArray(args.data) ? args.data : [args.data]
          args = {
            ...args,
            data: data.map((row: Record<string, unknown>) => (row.id ? row : { ...row, id: crypto.randomUUID() })),
          }
        }
      }
    } catch {
      // Logging must never fail the write; the row is caught on its next change.
      before = []
    }

    const result = await query(args)

    void (async () => {
      let changes: Change[] = []
      if (operation === 'delete' || operation === 'deleteMany') {
        changes = await changesFor(model, before, 'delete', ids)
      } else if (operation === 'updateMany') {
        changes = await changesFor(model, before, 'upsert', ids)
      } else if (operation === 'createMany') {
        const data = Array.isArray(args.data) ? args.data : [args.data]
        changes = await changesFor(model, data, 'upsert', ids)
      } else if (Array.isArray(result)) {
        changes = await changesFor(model, result, 'upsert', ids)
      } else if (result && typeof result === 'object') {
        changes = await changesFor(model, [result], 'upsert', ids)
      }
      await record(changes)
    })().catch((err) => {
      console.warn(`[HostChangeLog] could not log ${model}.${operation}: ${(err as Error)?.message ?? err}`)
    })

    return result
  }

  return { around, hostedIds }
}

/** Wrap the cloud client so writes to hosted workspaces feed their desktop. */
export function withHostChangeLog<T>(client: T): T {
  const log = createHostChangeLog(client)
  return (client as any).$extends({
    name: 'host-change-log',
    query: {
      $allModels: {
        $allOperations(params: any) {
          return log.around(params)
        },
      },
    },
  }) as T
}
