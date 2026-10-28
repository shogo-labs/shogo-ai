// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud half of the machine copy: apply a batch a paired desktop pushed
 * (SHO-185).
 *
 * Design rules, in the order they matter:
 *
 * 1. **The desktop keeps its ids.** A row is written with the id the desktop
 *    uses, so a Studio URL is the same URL on both sides and no mapping table is
 *    needed anywhere.
 * 2. **A desktop can only ever write rows it owns.** Every row is checked
 *    against `machine_mirror_rows`; a row owned by the cloud or by another
 *    machine rejects the whole batch with `409 mirror_ownership`, so guessing an
 *    id cannot overwrite anything.
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
  | { code: 'mirror_ownership'; message: string; detail?: Record<string, unknown> }
  | { code: 'epoch_mismatch'; message: string; epoch: string }
  | { code: 'unknown_model'; message: string }
  | { code: 'workspace_ownership'; message: string; detail?: Record<string, unknown> }

export interface IngestSuccess {
  ok: true
  epoch: string
  cursor: number
  applied: number
  deleted: number
  syncedAt: string
  /** Sync is switched off for this machine: the desktop should stop pushing. */
  disabled?: boolean
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

interface ModelMeta {
  model: ParsedModel
  /** Scalar/enum column names, for dropping unknown columns. */
  columns: Set<string>
  /** Columns that must carry a value on create. */
  required: Array<{ name: string; type: ScalarType }>
  hasWorkspaceId: boolean
  order: number
}

let metadata: Map<string, ModelMeta> | null = null

function loadMetadata(): Map<string, ModelMeta> {
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
    })
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
  for (const [key, value] of Object.entries(row)) {
    if (!meta.columns.has(key)) continue
    if (value === undefined) continue
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
 * Returns the failure to send back, or what the desktop should record as acked.
 * The caller (the route) owns the HTTP shape.
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
    // Sync was switched off while the desktop kept pushing: tell it to stop.
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

  // A delta batch under an epoch the cloud does not hold means the desktop's
  // database was recreated; it has to send a snapshot before anything else.
  if (mode === 'changes' && state?.epoch && requestedEpoch && state.epoch !== requestedEpoch) {
    return error('epoch_mismatch', 'Send a full snapshot under a new epoch', {
      epoch: state.epoch,
    })
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

  const allIds = ordered.flatMap((entry) => entry.rows.map((row) => String(row.id)))
  const deleteIds = (body.deletes ?? []).map((entry) => entry.recordId)
  const ownedRows = allIds.length || deleteIds.length
    ? await prisma.machineMirrorRow.findMany({
        where: {
          recordId: { in: [...new Set([...allIds, ...deleteIds])] },
          model: { in: [...new Set([...ordered.map((entry) => entry.model), ...(body.deletes ?? []).map((d) => d.model)])] },
        },
      })
    : []
  const ownerByKey = new Map(ownedRows.map((row) => [`${row.model}\u0000${row.recordId}`, row.instanceId]))

  let applied = 0
  let deleted = 0
  const taggedWorkspaces = new Set<string>()

  try {
    await prisma.$transaction(async (tx) => {
    for (const entry of ordered) {
      const modelMeta = meta.get(entry.model)
      if (!modelMeta) return
      const delegate = (tx as any)[delegateName(entry.model)]
      if (!delegate) throw new Error(`machine sync: no Prisma delegate for ${entry.model}`)

      for (const raw of entry.rows) {
        const row = normaliseRow(entry.model, raw, modelMeta)
        if (!row) continue
        const recordId = String(row.id)
        const key = `${entry.model}\u0000${recordId}`
        const owner = ownerByKey.get(key)

        // Ownership: new id, or already this machine's. Anything else is a
        // desktop trying to write a row that is not its own.
        if (owner && owner !== instanceId) {
          throw new OwnershipError(`${entry.model}/${recordId} belongs to ${owner}`)
        }

        const rewritten = applyRewrites(entry.model, row, { instanceId, homeRegion })

        if (modelMeta.hasWorkspaceId) {
          const workspaceId = rewritten.workspaceId
          if (typeof workspaceId === 'string') {
            const tagged = taggedWorkspaces.has(workspaceId)
              ? true
              : await isTaggedWorkspace(tx, workspaceId, instanceId)
            if (!tagged) {
              throw new WorkspaceOwnershipError(
                `${entry.model}/${recordId} points at workspace ${workspaceId}, which this machine does not own`,
              )
            }
          }
        }

        if (!owner) {
          // The id could still be a cloud row of the same model that the mirror
          // table does not track (a row created before this machine existed).
          const existing = await delegate.findUnique({
            where: { id: recordId },
            select: { id: true },
          })
          if (existing) {
            throw new OwnershipError(`${entry.model}/${recordId} already exists in the cloud`)
          }
        }

        await delegate.upsert({
          where: { id: recordId },
          create: rewritten,
          update: rewritten,
        })
        await tx.machineMirrorRow.upsert({
          where: { model_recordId: { model: entry.model, recordId } },
          create: { model: entry.model, recordId, instanceId, epoch },
          update: { instanceId, epoch },
        })
        if (entry.model === 'Workspace') taggedWorkspaces.add(recordId)
        applied++
      }
    }

    for (const entry of ordered) {
      if (entry.model !== 'Workspace') continue
      for (const row of entry.rows) {
        await ensureOwnerMember(tx, String(row.id), ownerUserId)
      }
    }

    for (const entry of body.deletes ?? []) {
      if (!isMirroredModel(entry.model)) continue
      const owner = ownerByKey.get(`${entry.model}\u0000${entry.recordId}`)
      // A delete for a row this machine does not own is ignored: the row was
      // never here, or a later batch from the owner will speak for it.
      if (owner !== instanceId) continue
      const delegate = (tx as any)[delegateName(entry.model)]
      await delegate.deleteMany({ where: { id: entry.recordId } })
      await tx.machineMirrorRow.deleteMany({ where: { model: entry.model, recordId: entry.recordId } })
      deleted++
    }

    const snapshotComplete = mode === 'snapshot' && body.snapshot?.complete === true
    if (snapshotComplete) {
      const removed = await dropOtherEpochs(tx, instanceId, epoch)
      deleted += removed
    }

    await tx.machineSyncState.upsert({
      where: { instanceId },
      create: {
        instanceId,
        epoch,
        cursor: typeof body.cursor === 'number' ? body.cursor : 0,
        lastIngestAt: new Date(),
        enabled: true,
      },
      update: {
        epoch,
        ...(typeof body.cursor === 'number' ? { cursor: body.cursor } : {}),
        lastIngestAt: new Date(),
        },
      })
    })
  } catch (err) {
    // Ownership violations are a decision, not a fault: report them as a failure
    // the route turns into a 409, and let the transaction roll back.
    const failure = ownershipFailure(err)
    if (failure) return failure
    throw err
  }

  const syncedAt = new Date().toISOString()
  return {
    ok: true,
    epoch,
    cursor: typeof body.cursor === 'number' ? body.cursor : 0,
    applied,
    deleted,
    syncedAt,
  }
}

class OwnershipError extends Error {}
class WorkspaceOwnershipError extends Error {}

/** Rejected rows carry the code the desktop acts on. */
export function ownershipFailure(err: unknown): IngestFailure | null {
  if (err instanceof OwnershipError) {
    return error('mirror_ownership', err.message, {})
  }
  if (err instanceof WorkspaceOwnershipError) {
    return error('workspace_ownership', err.message, {})
  }
  return null
}

async function isTaggedWorkspace(
  tx: any,
  workspaceId: string,
  instanceId: string,
): Promise<boolean> {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { machineInstanceId: true },
  })
  return workspace?.machineInstanceId === instanceId
}

/**
 * The machine's owner reads its copy through the normal cloud routes, so they
 * need a `Member` row on the tagged workspace. Idempotent: the desktop's own
 * member rows use local user ids and never match this one.
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
 * After a completed snapshot, everything this machine sent under an earlier
 * epoch is gone from the desktop database: delete those rows, children first.
 */
async function dropOtherEpochs(tx: any, instanceId: string, epoch: string): Promise<number> {
  const stale = await tx.machineMirrorRow.findMany({
    where: { instanceId, epoch: { not: epoch } },
    select: { model: true, recordId: true },
  })
  if (!stale.length) return 0
  const order = loadMetadata()
  const byModel = new Map<string, string[]>()
  for (const row of stale) {
    const ids = byModel.get(row.model) ?? []
    ids.push(row.recordId)
    byModel.set(row.model, ids)
  }
  const models = [...byModel.keys()].sort(
    (a, b) => (order.get(b)?.order ?? 0) - (order.get(a)?.order ?? 0),
  )
  let removed = 0
  for (const model of models) {
    const delegate = tx[delegateName(model)]
    if (!delegate) continue
    const ids = byModel.get(model)!
    // `deleteMany` on a parent with children still present throws; the model
    // order above makes sure children go first.
    const result = await delegate.deleteMany({ where: { id: { in: ids } } })
    removed += result.count ?? 0
  }
  await tx.machineMirrorRow.deleteMany({ where: { instanceId, epoch: { not: epoch } } })
  return removed
}

/**
 * Remove every row of a machine's copy — used when sync is switched off or the
 * machine is unpaired. Children before parents, then the workspace rows, the
 * copied user, and the bookkeeping.
 */
export async function deleteMachineCopy(
  prisma: PrismaClient,
  instanceId: string,
): Promise<{ rows: number; workspaces: number }> {
  const meta = loadMetadata()
  const mirrorRows = await prisma.machineMirrorRow.findMany({
    where: { instanceId },
    select: { model: true, recordId: true },
  })
  const byModel = new Map<string, string[]>()
  for (const row of mirrorRows) {
    const ids = byModel.get(row.model) ?? []
    ids.push(row.recordId)
    byModel.set(row.model, ids)
  }
  const models = [...byModel.keys()].sort(
    (a, b) => (meta.get(b)?.order ?? 0) - (meta.get(a)?.order ?? 0),
  )

  let rows = 0
  for (const model of models) {
    const delegate = (prisma as any)[delegateName(model)]
    if (!delegate) continue
    const ids = byModel.get(model)!
    for (let offset = 0; offset < ids.length; offset += 500) {
      const slice = ids.slice(offset, offset + 500)
      const result = await delegate.deleteMany({ where: { id: { in: slice } } })
      rows += result.count ?? 0
    }
  }

  const workspaces = byModel.get('Workspace') ?? []
  await prisma.machineMirrorRow.deleteMany({ where: { instanceId } })
  // The switch outlives the copy. Deleting the state row instead would let a
  // desktop that is still running recreate the copy a person just switched off.
  await prisma.machineSyncState.upsert({
    where: { instanceId },
    create: { instanceId, enabled: false, cursor: 0, epoch: '' },
    update: { enabled: false, cursor: 0, epoch: '' },
  })
  return { rows, workspaces: workspaces.length }
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
