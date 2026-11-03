// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud half of a hosted workspace's sync: apply a batch its desktop pushed
 * (SHO-185, reworked for the metal model in SHO-285).
 *
 * Design rules, in the order they matter:
 *
 * 1. **One id, one user.** A row is written with the id it has on both sides,
 *    and the desktop's user is the cloud account, so no mapping is needed.
 * 2. **A desktop can only write rows of the workspaces it hosts.** Each row's
 *    workspace is resolved through the schema's foreign keys; a row of any other
 *    workspace rejects the batch with `409 workspace_ownership`, so guessing an
 *    id cannot overwrite anything. Conflicts with cloud writes to the same row
 *    resolve last-writer-wins by `updatedAt`.
 * 3. **Version skew is expected.** Unknown columns are dropped and missing
 *    required ones are filled, so a desktop one version behind or ahead still
 *    syncs. Never fail a batch for a field.
 * 4. **One transaction per request**, so a batch is all-or-nothing and a reader
 *    never sees half a graph.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '../../generated/prisma-pg/client'
import { applyRewrites, delegateName, isMirroredModel, MIRROR_MODELS } from './models'
import { incomingWins } from './ingest-lww'

export { incomingWins }
import {
  columnFields,
  foreignKeys,
  isRequiredOnCreate,
  parseSchema,
  writeOrder,
  type ParsedModel,
  type ScalarType,
} from './schema-model'

export interface IngestRequest {
  epoch?: string
  mode?: 'changes' | 'snapshot'
  cursor?: number
  models?: Array<{ model: string; rows: Array<Record<string, unknown>> }>
  deletes?: Array<{ model: string; recordId: string }>
  snapshot?: { complete?: boolean; models?: string[] }
}

export type IngestFailure =
  | { code: 'epoch_mismatch'; message: string; epoch: string }
  | { code: 'unknown_model'; message: string }
  | { code: 'workspace_ownership'; message: string; detail?: Record<string, unknown> }

export interface IngestSuccess {
  ok: true
  epoch: string
  cursor: number
  applied: number
  deleted: number
  /** Snapshot rows left out because their parent row is not in the copy yet. */
  skipped?: number
  syncedAt: string
  /** Sync is switched off for this machine: the desktop should stop pushing. */
  disabled?: boolean
  /** Workspaces this batch created in the cloud — now hosted by the machine. */
  newWorkspaces?: number
}

export interface IngestContext {
  prisma: PrismaClient
  instanceId: string
  /** Cloud `User.id` of the machine's owner — added as a member of each copy. */
  ownerUserId: string
  /** The region this pod writes in. */
  homeRegion: string
}

// ─── Schema metadata (read once) ────────────────────────────────────────────

export interface ModelMeta {
  model: ParsedModel
  /** Scalar/enum column names, for dropping unknown columns. */
  columns: Set<string>
  /** Columns that must carry a value on create. */
  required: Array<{ name: string; type: ScalarType }>
  hasWorkspaceId: boolean
  order: number
  /**
   * Foreign keys that trace this model back to a workspace: `column` holds the
   * parent's id, `target` is the parent model. Empty for a model nothing in a
   * workspace points at.
   */
  scope: Array<{ column: string; target: string }>
}

let metadata: Map<string, ModelMeta> | null = null

export function loadMetadata(): Map<string, ModelMeta> {
  if (metadata) return metadata
  const candidates = [
    process.env.SHOGO_PRISMA_SCHEMA,
    // `fileURLToPath`, not `URL.pathname`: a pathname stays percent-encoded, so
    // an install directory with a space in it (macOS `Application Support`)
    // silently made this unreadable.
    fileURLToPath(new URL('../../../../../prisma/schema.prisma', import.meta.url)),
    `${process.cwd()}/prisma/schema.prisma`,
  ].filter(Boolean) as string[]

  let source: string | null = null
  for (const candidate of candidates) {
    try {
      source = readFileSync(candidate, 'utf8')
      break
    } catch {
      /* try the next location */
    }
  }
  if (!source) {
    // Without the schema we cannot drop unknown columns. Refusing here is
    // better than writing arbitrary keys into the database.
    throw new Error('machine sync: prisma/schema.prisma is not readable from this process')
  }

  const parsed = parseSchema(source)
  const order = writeOrder(parsed)
  const map = new Map<string, ModelMeta>()
  for (const model of parsed.models) {
    map.set(model.name, {
      model,
      columns: new Set(columnFields(model).map((field) => field.name)),
      required: columnFields(model)
        .filter(isRequiredOnCreate)
        .map((field) => ({ name: field.name, type: field.typeName as ScalarType })),
      hasWorkspaceId: model.fields.some((field) => field.name === 'workspaceId'),
      order: order.get(model.name) ?? 0,
      scope: [],
    })
  }

  // Which rows of a model belong to a workspace — directly (`project.workspaceId`)
  // or through a parent (`chatMessage.sessionId → chatSession`). Built from the
  // schema's own foreign keys so a new model is covered without a list here, and
  // so a parent that links to its workspace by an unusual column (`ChatSession`'s
  // project is `contextId`) still resolves.
  const roots = new Set(['Workspace'])
  for (let depth = 0; depth < 4; depth++) {
    let added = false
    for (const [name, modelMeta] of map) {
      if (modelMeta.scope.length || roots.has(name)) continue
      for (const fk of foreignKeys(modelMeta.model)) {
        const [fromModel, column] = fk.from.split('.')
        if (fromModel !== name) continue
        const target = fk.to.split('.')[0]
        if (target === name) continue
        // The workspace column itself is handled by `hasWorkspaceId`.
        if (column === 'workspaceId' && target === 'Workspace') continue
        const targetMeta = map.get(target)
        if (!targetMeta) continue
        if (roots.has(target) || targetMeta.hasWorkspaceId || targetMeta.scope.length) {
          modelMeta.scope.push({ column, target })
        }
      }
      if (modelMeta.scope.length) added = true
    }
    if (!added) break
  }

  metadata = map
  return map
}

/** Exposed so a test can point the loader at a fixture schema. */
export function resetMetadataCacheForTests(): void {
  metadata = null
}

/** A stand-in for a column the desktop was too old to send. */
function filler(type: ScalarType): unknown {
  switch (type) {
    case 'Int':
      return 0
    case 'BigInt':
      return 0
    case 'Float':
    case 'Decimal':
      return 0
    case 'Boolean':
      return false
    case 'DateTime':
      return new Date(0)
    case 'Json':
      return {}
    case 'Bytes':
      return new Uint8Array()
    default:
      return ''
  }
}

/** Keep the columns the cloud has; drop the rest. Fill what a batch omitted. */
export function normaliseRow(
  model: string,
  row: Record<string, unknown>,
  meta: ModelMeta,
): Record<string, unknown> | null {
  const id = row.id
  if (typeof id !== 'string' || !id) return null

  const out: Record<string, unknown> = {}
  const listFields = new Set(
    meta.model.fields.filter((field) => field.isList).map((field) => field.name),
  )
  const stringFields = new Set(
    meta.model.fields
      .filter((field) => !field.isList && !field.isRelation && field.typeName === 'String')
      .map((field) => field.name),
  )
  for (const [key, value] of Object.entries(row)) {
    if (!meta.columns.has(key)) continue
    if (value === undefined) continue
    // The desktop's SQLite client JSON-parses some columns by name alone
    // (`create-prisma-client.ts`), so a column that is a plain String here can
    // arrive as an object or array — `Meeting.transcript` did, and every
    // snapshot from that machine died on it (PERF-12). Store the text form.
    if (stringFields.has(key) && value !== null && typeof value === 'object' && !(value instanceof Date)) {
      out[key] = JSON.stringify(value)
      continue
    }
    // A list column is an array on Postgres but a JSON string on the desktop;
    // anything that is not an array yet is decoded, or dropped.
    if (listFields.has(key) && !Array.isArray(value)) {
      try {
        const parsed = JSON.parse(String(value))
        out[key] = Array.isArray(parsed) ? parsed : []
      } catch {
        out[key] = []
      }
      continue
    }
    out[key] = value
  }
  for (const field of meta.required) {
    if (out[field.name] === undefined || out[field.name] === null) {
      out[field.name] = filler(field.type)
    }
  }
  return out
}

// ─── Which workspace a row belongs to ───────────────────────────────────────

/**
 * Resolves the workspace of a row of any mirrored model, through the schema's
 * own foreign keys (`ModelMeta.scope`), memoised per instance. Used by ingest
 * (a desktop may only write rows of the workspaces it hosts) and by the cloud
 * change log (only rows of hosted workspaces are fed back down).
 */
export class WorkspaceResolver {
  private readonly memo = new Map<string, string | null>()
  constructor(private readonly db: any) {}

  /** Remember an answer the caller already knows (a row it just wrote). */
  remember(model: string, id: string, workspaceId: string | null): void {
    this.memo.set(`${model}\u0000${id}`, workspaceId)
  }

  async ofRow(model: string, row: Record<string, unknown>, depth = 0): Promise<string | null> {
    if (model === 'Workspace') return typeof row.id === 'string' ? row.id : null
    const meta = loadMetadata().get(model)
    if (!meta || depth > 5) return null
    if (meta.hasWorkspaceId && typeof row.workspaceId === 'string' && row.workspaceId) return row.workspaceId
    for (const { column, target } of meta.scope) {
      const parentId = row[column]
      if (typeof parentId !== 'string' || !parentId) continue
      const found = await this.ofId(target, parentId, depth + 1)
      if (found) return found
    }
    return null
  }

  async ofId(model: string, id: string, depth = 0): Promise<string | null> {
    if (model === 'Workspace') return id
    const key = `${model}\u0000${id}`
    if (this.memo.has(key)) return this.memo.get(key) ?? null
    const meta = loadMetadata().get(model)
    const delegate = this.db[delegateName(model)]
    if (!meta || !delegate) return null
    const select: Record<string, true> = { id: true }
    if (meta.hasWorkspaceId) select.workspaceId = true
    for (const { column } of meta.scope) select[column] = true
    const row = await delegate.findUnique({ where: { id }, select }).catch(() => null)
    const workspaceId = row ? await this.ofRow(model, row, depth) : null
    this.memo.set(key, workspaceId)
    return workspaceId
  }

  /** Columns a row must carry for `ofRow` to answer without a lookup of itself. */
  static scopeColumns(model: string): string[] {
    const meta = loadMetadata().get(model)
    if (!meta) return []
    return [...(meta.hasWorkspaceId ? ['workspaceId'] : []), ...meta.scope.map((s) => s.column)]
  }
}

/**
 * Snapshot rows that point at a mirrored parent row the cloud does not have.
 *
 * Packaged desktops up to 2.4.5 send snapshot pages in the wrong order
 * (`StarredProject` before `Project`), one model per request, so a parent can
 * only ever arrive in a later request. Writing the child fails the foreign key,
 * the whole page 500s, and the desktop restarts the snapshot every couple of
 * seconds, forever (PERF-14). Skipping the child lets the snapshot finish; the
 * row comes across the next time it changes.
 */
async function findOrphans(
  tx: any,
  model: string,
  rows: Array<Record<string, unknown>>,
  meta: ModelMeta,
): Promise<Set<string>> {
  const orphans = new Set<string>()
  for (const fk of foreignKeys(meta.model)) {
    const column = fk.from.split('.')[1]
    const [targetModel, targetColumn] = fk.to.split('.')
    if (targetModel === model || !isMirroredModel(targetModel) || targetColumn !== 'id') continue
    const wanted = new Set<string>()
    for (const row of rows) {
      const value = row[column]
      if (typeof value === 'string' && value) wanted.add(value)
    }
    if (!wanted.size) continue
    const found: Array<{ id: string }> = await tx[delegateName(targetModel)].findMany({
      where: { id: { in: [...wanted] } },
      select: { id: true },
    })
    const present = new Set(found.map((row) => row.id))
    for (const row of rows) {
      const value = row[column]
      if (typeof value === 'string' && value && !present.has(value)) orphans.add(String(row.id))
    }
  }
  return orphans
}

// ─── Apply ──────────────────────────────────────────────────────────────────

function error(code: IngestFailure['code'], message: string, extra?: Record<string, unknown>): IngestFailure {
  if (code === 'epoch_mismatch') {
    return { code, message, epoch: String(extra?.epoch ?? '') }
  }
  return { code, message, detail: extra }
}

/**
 * Apply one pushed batch.
 *
 * A paired desktop hosts its workspaces (SHO-285): the rows are the same rows
 * on both sides and either side may write them. So the only rule about *which*
 * rows a desktop may write is the workspace rule — every row must belong to a
 * workspace this machine hosts (or be a new workspace, which it then hosts).
 * Guessing the id of somebody else's row is refused as `workspace_ownership`.
 * Conflicts between the two sides resolve last-writer-wins per row.
 *
 * Returns the failure to send back, or what the desktop should record as acked.
 */
export async function applyBatch(
  ctx: IngestContext,
  body: IngestRequest,
): Promise<IngestSuccess | IngestFailure> {
  const { prisma, instanceId, ownerUserId, homeRegion } = ctx
  const meta = loadMetadata()
  const requestedEpoch = typeof body.epoch === 'string' ? body.epoch : ''
  const mode = body.mode === 'snapshot' ? 'snapshot' : 'changes'

  const state = await prisma.machineSyncState.findUnique({ where: { instanceId } })
  if (state && state.enabled === false) {
    return {
      ok: true,
      disabled: true,
      epoch: state.epoch,
      cursor: Number(state.cursor),
      applied: 0,
      deleted: 0,
      syncedAt: state.lastIngestAt?.toISOString() ?? new Date().toISOString(),
    }
  }

  // A delta batch only makes sense after an accepted snapshot (SHO-241):
  // `epoch_mismatch` is the code every shipped pusher answers with a snapshot.
  const snapshotAccepted = Boolean(state?.lastIngestAt)
  if (mode === 'changes' && (!state || !snapshotAccepted)) {
    return error('epoch_mismatch', 'No accepted snapshot for this machine — send a full one', {
      epoch: state?.epoch ?? '',
    })
  }
  if (mode === 'changes' && state?.epoch && requestedEpoch && state.epoch !== requestedEpoch) {
    return error('epoch_mismatch', 'Send a full snapshot under a new epoch', { epoch: state.epoch })
  }

  const epoch = mode === 'snapshot' ? requestedEpoch || state?.epoch || crypto.randomUUID() : state?.epoch ?? requestedEpoch
  if (!epoch) return error('epoch_mismatch', 'An epoch is required', { epoch: '' })

  const models = body.models ?? []
  for (const entry of models) {
    if (!isMirroredModel(entry.model)) {
      return error('unknown_model', `${entry.model} is not a mirrored model`)
    }
  }

  // Parents before children, whatever order the desktop sent.
  const ordered = [...models].sort(
    (a, b) => (meta.get(a.model)?.order ?? 0) - (meta.get(b.model)?.order ?? 0),
  )

  let applied = 0
  let deleted = 0
  let skipped = 0
  let newWorkspaces = 0

  try {
    await prisma.$transaction(async (tx) => {
      const hosted = new Set<string>(
        (
          (await (tx as any).workspace.findMany({
            where: { hostInstanceId: instanceId },
            select: { id: true },
          })) as Array<{ id: string }>
        ).map((row) => row.id),
      )
      const resolver = new WorkspaceResolver(tx)
      const mayWrite = (workspaceId: string | null) => Boolean(workspaceId && hosted.has(workspaceId))

      for (const entry of ordered) {
        const modelMeta = meta.get(entry.model)
        if (!modelMeta) continue
        const delegate = (tx as any)[delegateName(entry.model)]
        if (!delegate) throw new Error(`machine sync: no Prisma delegate for ${entry.model}`)

        const ids = entry.rows.map((raw) => String(raw.id)).filter(Boolean)
        const existingRows = ids.length
          ? ((await delegate.findMany({ where: { id: { in: ids } } })) as Array<Record<string, unknown>>)
          : []
        const existingById = new Map(existingRows.map((row) => [String(row.id), row]))
        const orphans = mode === 'snapshot'
          ? await findOrphans(tx, entry.model, entry.rows, modelMeta)
          : new Set<string>()
        if (orphans.size) {
          console.warn(
            `[MachineSync] ${instanceId}: skipped ${orphans.size} ${entry.model} snapshot row(s) whose parent row is not in the cloud yet`,
          )
        }

        for (const raw of entry.rows) {
          const row = normaliseRow(entry.model, raw, modelMeta)
          if (!row) continue
          const recordId = String(row.id)
          if (orphans.has(recordId)) {
            skipped++
            continue
          }
          const existing = existingById.get(recordId)

          // One user (SHO-285): the desktop's user *is* the cloud account, and a
          // cloud `User` row is never overwritten from a device.
          if (entry.model === 'User') {
            if (existing) continue
            await delegate.create({ data: applyRewrites(entry.model, row, { instanceId, homeRegion }) })
            applied++
            continue
          }

          const rewritten = applyRewrites(entry.model, row, { instanceId, homeRegion })

          if (entry.model === 'Workspace') {
            if (existing && existing.hostInstanceId !== instanceId) {
              throw new WorkspaceOwnershipError(`Workspace/${recordId} is not hosted on this machine`)
            }
            if (!existing) newWorkspaces++
            hosted.add(recordId)
          } else {
            const target = await resolver.ofRow(entry.model, rewritten)
            const current = existing ? await resolver.ofRow(entry.model, existing) : target
            if (!target || !current) {
              // The parent is not here (yet). A snapshot page may legally name a
              // parent the next page brings (PERF-14); the row comes across the
              // next time it changes.
              skipped++
              continue
            }
            if (!mayWrite(target) || !mayWrite(current)) {
              throw new WorkspaceOwnershipError(
                `${entry.model}/${recordId} belongs to a workspace this machine does not host`,
              )
            }
            resolver.remember(entry.model, recordId, target)
          }

          if (!incomingWins(existing, rewritten)) {
            skipped++
            continue
          }

          if (entry.model === 'Member') {
            // The cloud may hold the same membership under another id (the
            // owner row ingest grants before the desktop's own arrives).
            await (tx as any).member.deleteMany({
              where: {
                id: { not: recordId },
                userId: rewritten.userId,
                workspaceId: rewritten.workspaceId ?? null,
                projectId: rewritten.projectId ?? null,
              },
            })
          }

          await delegate.upsert({
            where: { id: recordId },
            create: rewritten,
            update: rewritten,
          })
          applied++
        }
      }

      for (const workspaceId of hosted) {
        if (ordered.some((entry) => entry.model === 'Workspace' && entry.rows.some((row) => row.id === workspaceId))) {
          await ensureOwnerMember(tx, workspaceId, ownerUserId)
        }
      }

      for (const entry of body.deletes ?? []) {
        if (!isMirroredModel(entry.model) || entry.model === 'User') continue
        const workspaceId = entry.model === 'Workspace' ? entry.recordId : await resolver.ofId(entry.model, entry.recordId)
        // A delete for a row that is not here, or not in a hosted workspace, is
        // ignored: the row was never here, or is not this machine's to delete.
        if (!mayWrite(workspaceId)) continue
        const delegate = (tx as any)[delegateName(entry.model)]
        const result = await delegate.deleteMany({ where: { id: entry.recordId } })
        deleted += result.count ?? 0
      }

      const snapshotComplete = mode === 'snapshot' && body.snapshot?.complete === true
      // `lastIngestAt` means "an accepted copy exists" (SHO-241): only a
      // completed snapshot, or a delta (which can only follow one), sets it.
      const ingestedAt = mode === 'changes' || snapshotComplete ? new Date() : null

      await tx.machineSyncState.upsert({
        where: { instanceId },
        create: {
          instanceId,
          epoch,
          cursor: typeof body.cursor === 'number' ? body.cursor : 0,
          lastIngestAt: ingestedAt,
          enabled: true,
        },
        update: {
          epoch,
          ...(typeof body.cursor === 'number' ? { cursor: body.cursor } : {}),
          ...(ingestedAt ? { lastIngestAt: ingestedAt } : {}),
        },
      })
    }, { timeout: 60_000, maxWait: 10_000 })
  } catch (err) {
    const failure = ownershipFailure(err)
    if (failure) return failure
    throw err
  }

  return {
    ok: true,
    epoch,
    cursor: typeof body.cursor === 'number' ? body.cursor : 0,
    applied,
    deleted,
    ...(skipped ? { skipped } : {}),
    ...(newWorkspaces ? { newWorkspaces } : {}),
    syncedAt: new Date().toISOString(),
  }
}

class WorkspaceOwnershipError extends Error {}

/** Rejected rows carry the code the desktop acts on. */
export function ownershipFailure(err: unknown): IngestFailure | null {
  if (err instanceof WorkspaceOwnershipError) {
    return error('workspace_ownership', err.message, {})
  }
  return null
}

/**
 * The machine's owner needs a workspace `Member` row to reach a hosted
 * workspace through the normal routes. After the one-user rewrite the desktop's
 * own member row already is that row; this covers the first batch.
 */
async function ensureOwnerMember(tx: any, workspaceId: string, ownerUserId: string): Promise<void> {
  const existing = await tx.member.findFirst({
    where: { workspaceId, userId: ownerUserId, projectId: null },
    select: { id: true },
  })
  if (existing) return
  await tx.member.create({
    data: { workspaceId, userId: ownerUserId, role: 'owner', isBillingAdmin: false },
  })
}

/**
 * Unpairing a machine (or switching its sync off) hands its workspaces back to
 * cloud compute. Nothing is deleted: a hosted workspace is a real workspace,
 * and what was written to it from either side is the person's data.
 */
export async function releaseHostedWorkspaces(
  prisma: PrismaClient,
  instanceId: string,
): Promise<{ workspaces: number }> {
  const result = await (prisma as any).workspace.updateMany({
    where: { hostInstanceId: instanceId },
    data: { hostInstanceId: null },
  })
  return { workspaces: result.count ?? 0 }
}

/** The mirror set, in write order — used by tests and by the snapshot guard. */
export function mirroredModelsInOrder(): string[] {
  const meta = loadMetadata()
  return [...MIRROR_MODELS].sort(
    (a, b) => (meta.get(a)?.order ?? 0) - (meta.get(b)?.order ?? 0),
  )
}

/** Every foreign key out of a mirrored model, for the ingest test. */
export function mirrorForeignKeys(): Array<{ from: string; to: string }> {
  const meta = loadMetadata()
  const out: Array<{ from: string; to: string }> = []
  for (const model of MIRROR_MODELS) {
    const parsed = meta.get(model)?.model
    if (!parsed) continue
    out.push(...foreignKeys(parsed))
  }
  return out
}
