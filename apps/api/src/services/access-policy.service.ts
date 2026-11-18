// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace RBAC (SHO-417): one resolver for "what may this person use".
 *
 *   ceiling  platform-visible models ∩ the workspace allow-list
 *            (`WorkspaceModelVisibility`). Nothing widens it.
 *   grants   the member's role policy ∪ every group policy ∪ their own policy.
 *            Grants only add, so there is no precedence to reason about.
 *   effective grants ∩ ceiling.
 *
 * The pure math lives in `@shogo/authz` (`resolvePolicy`); this module loads
 * the rows, caches the answer for 30 s, and is the only place the AI proxy,
 * the run-start model pick, the runtime's tool filter and the settings API ask.
 *
 * Every write calls `invalidateAccess(workspaceId)` synchronously, so a revoke
 * takes effect on the next request. On a multi-pod deploy the invalidation is
 * also published on the shared Redis so the other pods drop their copy.
 */

import {
  MODEL_TIERS,
  isAbilityPermissionName,
  isModelTier,
  isSpendPeriod,
  resolvePolicy,
  type AccessPolicyRow,
  type EffectivePolicy,
  type ModelGrant,
  type ModelInfo,
  type ModelTier,
  type Permission,
  type PolicySubjectType,
  type SpendPeriod,
  type WorkspaceRole,
} from '@shogo/authz'
import { prisma } from '../lib/prisma'
import { getPodId, getSharedRedis } from '../lib/tunnel-redis'
import { getMergedCatalogSync } from './model-registry.service'
import { getAllowedModelIds } from './workspace-models.service'
import { getAgentDefaultModel } from './workspace-agent.service'

const CACHE_TTL_MS = 30_000
const INVALIDATE_CHANNEL = 'access:invalidate'

export interface EffectiveAccess extends EffectivePolicy {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  /** The workspace ceiling (`null` = every platform-visible model). */
  ceiling: ReadonlySet<string> | null
}

interface CacheEntry {
  value: EffectiveAccess
  loadedAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

/** Drop every cached member of a workspace. Call after any policy write. */
export function invalidateAccess(workspaceId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key)
  }
  publishInvalidation(workspaceId)
}

function publishInvalidation(workspaceId: string): void {
  const redis = getSharedRedis()
  if (!redis) return
  try {
    void redis.publish(INVALIDATE_CHANNEL, JSON.stringify({ workspaceId, origin: getPodId() }))
  } catch {
    // A cache-bust that cannot be published is not worth failing a write for:
    // the local cache is already dropped and the TTL bounds the rest.
  }
}

let subscriber: { on: (event: string, fn: (channel: string, raw: string) => void) => void } | null = null

/**
 * Listen for other pods' invalidations. Called once from the server bootstrap;
 * a no-op in local mode (no Redis).
 */
export function startAccessInvalidationSubscriber(): void {
  if (subscriber) return
  const redis = getSharedRedis()
  if (!redis) return
  subscriber = redis as unknown as typeof subscriber
  subscriber!.on('message', (channel: string, raw: string) => {
    if (channel !== INVALIDATE_CHANNEL) return
    try {
      const payload = JSON.parse(raw) as { workspaceId?: string; origin?: string }
      if (!payload.workspaceId || payload.origin === getPodId()) return
      for (const key of cache.keys()) {
        if (key.startsWith(`${payload.workspaceId}:`)) cache.delete(key)
      }
    } catch {
      // ignore malformed payloads
    }
  })
  try {
    ;(redis as unknown as { subscribe: (channel: string) => Promise<unknown> }).subscribe(INVALIDATE_CHANNEL)
  } catch {
    // subscription is best-effort; the TTL still bounds staleness
  }
}

/** Test-only: clear the whole cache. */
export function __clearAccessCache(): void {
  cache.clear()
}

/**
 * The model catalog the resolver reasons about: id + tier, static + DB + cloud.
 * `displayName` rides along so the settings UI can label a grant without
 * keeping its own copy of the catalog.
 */
export function accessModelCatalog(): Array<ModelInfo & { displayName: string }> {
  return getMergedCatalogSync().map((m) => ({ id: m.id, tier: m.tier, displayName: m.displayName }))
}

function parseJsonArray(value: unknown): string[] | null {
  if (value == null) return null
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null
    } catch {
      return null
    }
  }
  return null
}

/** One stored row, in the shape the pure resolver takes. */
export function toPolicyRow(row: {
  subjectType: string
  subjectId: string
  abilities?: unknown
  modelTiers?: unknown
  modelIds?: unknown
  defaultModelId?: string | null
  spendCapUsd?: number | null
  spendPeriod?: string | null
  requestsPerHour?: number | null
}): AccessPolicyRow {
  return {
    subjectType: row.subjectType as PolicySubjectType,
    subjectId: row.subjectId,
    abilities: parseJsonArray(row.abilities),
    modelTiers: parseJsonArray(row.modelTiers),
    modelIds: parseJsonArray(row.modelIds),
    defaultModelId: row.defaultModelId ?? null,
    spendCapUsd: row.spendCapUsd ?? null,
    spendPeriod: row.spendPeriod ?? null,
    requestsPerHour: row.requestsPerHour ?? null,
  }
}

async function loadRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const member = (await prisma.member.findFirst({
    where: { userId, workspaceId, projectId: null },
    select: { role: true },
  })) as { role: string } | null
  const role = member?.role
  return role === 'owner' || role === 'admin' || role === 'member' || role === 'viewer' ? role : null
}

async function loadPolicies(workspaceId: string, userId: string, role: WorkspaceRole): Promise<AccessPolicyRow[]> {
  const groups = (await prisma.userGroupMember.findMany({
    where: { userId, group: { workspaceId } },
    select: { groupId: true },
  })) as Array<{ groupId: string }>
  const groupIds = groups.map((g) => g.groupId)

  const rows = (await prisma.accessPolicy.findMany({
    where: {
      workspaceId,
      OR: [
        { subjectType: 'role', subjectId: role },
        { subjectType: 'member', subjectId: userId },
        ...(groupIds.length ? [{ subjectType: 'group', subjectId: { in: groupIds } }] : []),
      ],
    },
  })) as Array<Parameters<typeof toPolicyRow>[0]>

  return rows.map(toPolicyRow)
}

function reasonsFor(role: WorkspaceRole, policies: readonly AccessPolicyRow[]): string[] {
  const reasons = [`role ${role}`]
  for (const p of policies) {
    if (p.subjectType === 'group') reasons.push(`group ${p.subjectId}`)
    if (p.subjectType === 'member') reasons.push('member grant')
  }
  return reasons
}

/**
 * The effective access of one member. `null` when they are not a workspace
 * member (a guest, or a stale id) — callers treat that as "no access".
 */
export async function getEffectiveAccess(
  workspaceId: string,
  userId: string,
): Promise<EffectiveAccess | null> {
  const key = cacheKey(workspaceId, userId)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.loadedAt <= CACHE_TTL_MS) return cached.value

  const role = await loadRole(workspaceId, userId)
  if (!role) return null

  const [policies, ceiling, workspaceDefaultModelId] = await Promise.all([
    loadPolicies(workspaceId, userId, role),
    getAllowedModelIds(workspaceId),
    getAgentDefaultModel(workspaceId).catch(() => null),
  ])

  const resolved = resolvePolicy({
    role,
    policies,
    ceiling,
    catalog: accessModelCatalog(),
    workspaceDefaultModelId,
    reasons: reasonsFor(role, policies),
  })

  const value: EffectiveAccess = {
    ...resolved,
    workspaceId,
    userId,
    role,
    ceiling,
  }
  cache.set(key, { value, loadedAt: Date.now() })
  return value
}

/** Whether the member may use `permission`. Unknown members get nothing. */
export async function canUse(
  workspaceId: string,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  const access = await getEffectiveAccess(workspaceId, userId)
  return access?.abilities.has(permission) ?? false
}

/**
 * Whether `modelId` is inside the member's effective set. `auto` is not
 * exempt: callers pass the concrete model `auto` resolved to.
 */
export async function isModelAllowedFor(
  workspaceId: string,
  userId: string,
  modelId: string,
): Promise<boolean> {
  const access = await getEffectiveAccess(workspaceId, userId)
  if (!access) return false
  const model = accessModelCatalog().find((m) => m.id === modelId)
  if (!model) {
    // An id the catalog does not know (a DB model added after the snapshot, or
    // an alias): fall back to the ceiling alone, which is today's behaviour.
    return access.ceiling === null || access.ceiling.has(modelId)
  }
  return isModelInGrant(access.models, model, access.ceiling)
}

function isModelInGrant(grant: ModelGrant, model: ModelInfo, ceiling: ReadonlySet<string> | null): boolean {
  if (ceiling !== null && !ceiling.has(model.id)) return false
  if (grant.tiers === null && grant.ids === null) return true
  if (grant.ids?.has(model.id)) return true
  return grant.tiers?.has(model.tier as ModelTier) ?? false
}

/** Every model id the member may use, catalog order kept. */
export async function allowedModelIdsFor(workspaceId: string, userId: string): Promise<string[]> {
  const access = await getEffectiveAccess(workspaceId, userId)
  if (!access) return []
  return accessModelCatalog()
    .filter((m) => isModelInGrant(access.models, m, access.ceiling))
    .map((m) => m.id)
}

/**
 * The auto tier map with every tier mapped to a model the member may use: the
 * configured model when it is allowed, else the next allowed model in the same
 * tier, else the cheapest allowed one. `null` when nothing is allowed.
 */
export async function allowedAutoTiers(
  workspaceId: string,
  userId: string,
  autoTiers: Record<string, string>,
): Promise<Record<string, string> | null> {
  const access = await getEffectiveAccess(workspaceId, userId)
  if (!access) return null
  const catalog = accessModelCatalog()
  const allowed = catalog.filter((m) => isModelInGrant(access.models, m, access.ceiling))
  if (allowed.length === 0) return null

  const cheapest = allowed.reduce((best, m) =>
    MODEL_TIERS.indexOf(m.tier as ModelTier) < MODEL_TIERS.indexOf(best.tier as ModelTier) ? m : best,
  )

  const out: Record<string, string> = {}
  for (const [tier, configured] of Object.entries(autoTiers)) {
    if (configured && allowed.some((m) => m.id === configured)) {
      out[tier] = configured
      continue
    }
    const sameTier = allowed.find((m) => m.tier === tier)
    out[tier] = sameTier?.id ?? cheapest.id
  }
  return out
}

/**
 * The model a run should use, given the agent's configured model. When the
 * configured model is outside the acting person's set, the run uses their
 * default model for that run only (Russell, 2026-11-18) and the caller states
 * it in the reply. `null` when the person has no allowed model at all.
 */
export async function resolveRunModelFor(
  workspaceId: string,
  userId: string,
  configuredModel: string,
): Promise<{ model: string; downgrade: { from: string; to: string } | null } | null> {
  const access = await getEffectiveAccess(workspaceId, userId)
  if (!access) return null
  const catalog = accessModelCatalog()
  const configured = catalog.find((m) => m.id === configuredModel)
  if (configured && isModelInGrant(access.models, configured, access.ceiling)) {
    return { model: configuredModel, downgrade: null }
  }
  const fallback = access.defaultModelId
  if (!fallback) return null
  return { model: fallback, downgrade: { from: configuredModel, to: fallback } }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AccessAuditKind =
  | 'policy.changed'
  | 'denied'
  | 'shadow_denied'
  | 'model.downgraded'
  | 'access.requested'
  | 'access.granted'
  | 'access.denied'

export interface AccessAuditInput {
  workspaceId: string
  kind: AccessAuditKind
  actorUserId?: string | null
  onBehalfOfUserId?: string | null
  permission?: string | null
  modelId?: string | null
  subject?: unknown
  detail?: unknown
}

/** At most one denial row per user × permission × 5 min, so a hot loop cannot flood the table. */
const denialDedupe = new Map<string, number>()
const DENIAL_DEDUPE_MS = 5 * 60_000

function shouldWrite(input: AccessAuditInput): boolean {
  if (input.kind !== 'denied' && input.kind !== 'shadow_denied') return true
  const key = `${input.workspaceId}:${input.onBehalfOfUserId ?? input.actorUserId ?? ''}:${input.permission ?? input.modelId ?? ''}:${input.kind}`
  const last = denialDedupe.get(key)
  const now = Date.now()
  if (last && now - last < DENIAL_DEDUPE_MS) return false
  denialDedupe.set(key, now)
  return true
}

/**
 * Write one audit row. Never throws: an audit failure must not fail a request.
 *
 * `subject` and `detail` are JSON text in both dialects — the SQLite schema
 * types them `String?` and the repo stores JSON-encoded strings in the PG
 * `Json?` columns too (see `ToolCallLog.args`), so one write path serves both.
 */
export async function recordAccessEvent(input: AccessAuditInput): Promise<void> {
  if (!shouldWrite(input)) return
  try {
    await prisma.accessAuditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        kind: input.kind,
        actorUserId: input.actorUserId ?? null,
        onBehalfOfUserId: input.onBehalfOfUserId ?? null,
        permission: input.permission ?? null,
        modelId: input.modelId ?? null,
        subject: input.subject == null ? undefined : JSON.stringify(input.subject),
        detail: input.detail == null ? undefined : JSON.stringify(input.detail),
      },
    })
  } catch (err) {
    console.warn('[access] audit write failed:', (err as Error).message)
  }
}

/** Test-only: reset the denial dedupe window. */
export function __clearAccessAuditDedupe(): void {
  denialDedupe.clear()
}

// ---------------------------------------------------------------------------
// Policy writes (the settings API)
// ---------------------------------------------------------------------------

export interface PolicyWrite {
  subjectType: PolicySubjectType
  subjectId: string
  abilities?: string[] | null
  modelTiers?: string[] | null
  modelIds?: string[] | null
  defaultModelId?: string | null
  spendCapUsd?: number | null
  spendPeriod?: string | null
  requestsPerHour?: number | null
}

export class PolicyValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/**
 * Validate a policy write against the catalog and the ceiling. Throws
 * `PolicyValidationError` with a code the route turns into a 400.
 */
export function validatePolicyWrite(
  write: PolicyWrite,
  ceiling: ReadonlySet<string> | null,
  catalog: readonly ModelInfo[],
): PolicyWrite {
  if (write.subjectType !== 'role' && write.subjectType !== 'group' && write.subjectType !== 'member') {
    throw new PolicyValidationError('subjectType must be role, group or member', 'invalid_subject')
  }
  if (!write.subjectId) throw new PolicyValidationError('subjectId is required', 'invalid_subject')

  const abilities = write.abilities ?? null
  if (abilities) {
    const bad = abilities.filter((a) => !isAbilityPermissionName(a))
    if (bad.length) {
      throw new PolicyValidationError(`Unknown abilities: ${bad.join(', ')}`, 'invalid_abilities')
    }
  }

  const tiers = write.modelTiers ?? null
  if (tiers) {
    const bad = tiers.filter((t) => !isModelTier(t))
    if (bad.length) {
      throw new PolicyValidationError(`Unknown model tiers: ${bad.join(', ')}`, 'invalid_model_tiers')
    }
  }

  const ids = write.modelIds ?? null
  if (ids) {
    const known = new Set(catalog.map((m) => m.id))
    const outside = ids.filter((id) => !known.has(id) || (ceiling !== null && !ceiling.has(id)))
    if (outside.length) {
      throw new PolicyValidationError(
        `These models are outside the workspace ceiling: ${outside.join(', ')}`,
        'invalid_models',
      )
    }
  }

  if (write.defaultModelId) {
    const known = new Set(catalog.map((m) => m.id))
    if (!known.has(write.defaultModelId) || (ceiling !== null && !ceiling.has(write.defaultModelId))) {
      throw new PolicyValidationError(
        `Default model is outside the workspace ceiling: ${write.defaultModelId}`,
        'invalid_default_model',
      )
    }
  }

  if (write.spendPeriod != null && !isSpendPeriod(write.spendPeriod)) {
    throw new PolicyValidationError('spendPeriod must be day, week or month', 'invalid_spend_period')
  }
  if (write.spendCapUsd != null && (typeof write.spendCapUsd !== 'number' || write.spendCapUsd < 0)) {
    throw new PolicyValidationError('spendCapUsd must be a non-negative number', 'invalid_spend_cap')
  }
  if (
    write.requestsPerHour != null &&
    (!Number.isInteger(write.requestsPerHour) || write.requestsPerHour < 0)
  ) {
    throw new PolicyValidationError('requestsPerHour must be a non-negative integer', 'invalid_rate_limit')
  }

  return write
}

/** Upsert one policy row and audit the before/after. */
export async function upsertPolicy(
  workspaceId: string,
  write: PolicyWrite,
  actorUserId: string | null,
): Promise<void> {
  const before = (await prisma.accessPolicy.findUnique({
    where: {
      workspaceId_subjectType_subjectId: {
        workspaceId,
        subjectType: write.subjectType,
        subjectId: write.subjectId,
      },
    },
  })) as Record<string, unknown> | null

  const data = {
    abilities: (write.abilities ?? null) as never,
    modelTiers: (write.modelTiers ?? null) as never,
    modelIds: (write.modelIds ?? null) as never,
    defaultModelId: write.defaultModelId ?? null,
    spendCapUsd: write.spendCapUsd ?? null,
    spendPeriod: write.spendPeriod ?? null,
    requestsPerHour: write.requestsPerHour ?? null,
    updatedBy: actorUserId,
  }

  await prisma.accessPolicy.upsert({
    where: {
      workspaceId_subjectType_subjectId: {
        workspaceId,
        subjectType: write.subjectType,
        subjectId: write.subjectId,
      },
    },
    create: { workspaceId, subjectType: write.subjectType, subjectId: write.subjectId, ...data },
    update: data,
  })

  invalidateAccess(workspaceId)
  await recordAccessEvent({
    workspaceId,
    kind: 'policy.changed',
    actorUserId,
    subject: { subjectType: write.subjectType, subjectId: write.subjectId },
    detail: { before, after: data },
  })
}

/** Delete one policy row (reverting the subject to its default) and audit it. */
export async function deletePolicy(
  workspaceId: string,
  subjectType: PolicySubjectType,
  subjectId: string,
  actorUserId: string | null,
): Promise<boolean> {
  const before = (await prisma.accessPolicy.findUnique({
    where: { workspaceId_subjectType_subjectId: { workspaceId, subjectType, subjectId } },
  })) as Record<string, unknown> | null
  if (!before) return false
  await prisma.accessPolicy.delete({
    where: { workspaceId_subjectType_subjectId: { workspaceId, subjectType, subjectId } },
  })
  invalidateAccess(workspaceId)
  await recordAccessEvent({
    workspaceId,
    kind: 'policy.changed',
    actorUserId,
    subject: { subjectType, subjectId },
    detail: { before, after: null },
  })
  return true
}

/** Drop a group's or member's policy rows when the group/member goes away. */
export async function deletePoliciesForSubject(
  workspaceId: string,
  subjectType: PolicySubjectType,
  subjectId: string,
): Promise<void> {
  await prisma.accessPolicy.deleteMany({ where: { workspaceId, subjectType, subjectId } })
  invalidateAccess(workspaceId)
}

/** Every policy row in a workspace, for the settings UI. */
export async function listPolicies(workspaceId: string): Promise<AccessPolicyRow[]> {
  const rows = (await prisma.accessPolicy.findMany({
    where: { workspaceId },
    orderBy: [{ subjectType: 'asc' }, { subjectId: 'asc' }],
  })) as Array<Parameters<typeof toPolicyRow>[0]>
  return rows.map(toPolicyRow)
}

/** The "why" behind a member's access, for the settings UI and the API. */
export async function explainAccess(
  workspaceId: string,
  userId: string,
): Promise<{
  role: WorkspaceRole
  abilities: Permission[]
  models: string[]
  defaultModelId: string | null
  spendCapUsd: number | null
  spendPeriod: SpendPeriod | null
  requestsPerHour: number | null
  reasons: string[]
} | null> {
  const access = await getEffectiveAccess(workspaceId, userId)
  if (!access) return null
  return {
    role: access.role,
    abilities: [...access.abilities].sort() as Permission[],
    models: await allowedModelIdsFor(workspaceId, userId),
    defaultModelId: access.defaultModelId,
    spendCapUsd: access.spendCapUsd,
    spendPeriod: access.spendPeriod,
    requestsPerHour: access.requestsPerHour,
    reasons: access.reasons,
  }
}

// ---------------------------------------------------------------------------
// Access requests — a member asks, an admin decides
// ---------------------------------------------------------------------------

/**
 * A request is an audit row, not a table of its own: `access.requested` opens
 * it, `access.granted` / `access.denied` closes it, and the decision row names
 * the request in its `subject`. That keeps one append-only history for "who
 * asked for what, who said yes" and means a request can never drift out of
 * sync with the audit trail it belongs to.
 */
export type AccessRequestStatus = 'open' | 'granted' | 'denied'

export interface AccessRequestRow {
  id: string
  userId: string
  permission: string | null
  modelId: string | null
  reason: string | null
  createdAt: string
  status: AccessRequestStatus
  decidedByUserId: string | null
  decidedAt: string | null
}

export class AccessRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

interface AuditRowLike {
  id: string
  kind: string
  actorUserId: string | null
  onBehalfOfUserId: string | null
  permission: string | null
  modelId: string | null
  subject: unknown
  createdAt: Date
}

function parseSubject(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

function toAccessRequestRow(
  row: AuditRowLike,
  decision?: { status: 'granted' | 'denied'; by: string | null; at: Date },
): AccessRequestRow {
  const subject = parseSubject(row.subject)
  return {
    id: row.id,
    userId: row.onBehalfOfUserId ?? row.actorUserId ?? '',
    permission: row.permission,
    modelId: row.modelId,
    reason: typeof subject.reason === 'string' ? subject.reason : null,
    createdAt: row.createdAt.toISOString(),
    status: decision?.status ?? 'open',
    decidedByUserId: decision?.by ?? null,
    decidedAt: decision?.at ? decision.at.toISOString() : null,
  }
}

/**
 * Requests plus their decisions, newest first. Decisions are always newer than
 * the request they close, so one descending window holds both — a request whose
 * decision fell outside the window is simply still open, which is the safe way
 * to be wrong (an admin can decide it again).
 */
async function loadAccessRequests(workspaceId: string, limit = 200): Promise<AccessRequestRow[]> {
  const rows = (await prisma.accessAuditEvent.findMany({
    where: {
      workspaceId,
      kind: { in: ['access.requested', 'access.granted', 'access.denied'] },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })) as AuditRowLike[]

  const decisions = new Map<string, { status: 'granted' | 'denied'; by: string | null; at: Date }>()
  for (const row of rows) {
    if (row.kind === 'access.requested') continue
    const requestId = parseSubject(row.subject).requestId
    if (typeof requestId !== 'string' || decisions.has(requestId)) continue
    decisions.set(requestId, {
      status: row.kind === 'access.granted' ? 'granted' : 'denied',
      by: row.actorUserId,
      at: row.createdAt,
    })
  }

  return rows
    .filter((row) => row.kind === 'access.requested')
    .map((row) => toAccessRequestRow(row, decisions.get(row.id)))
}

/** Open requests in a workspace, for the admin queue. */
export async function listAccessRequests(
  workspaceId: string,
  opts: { status?: AccessRequestStatus } = {},
): Promise<AccessRequestRow[]> {
  const rows = await loadAccessRequests(workspaceId)
  return opts.status ? rows.filter((row) => row.status === opts.status) : rows
}

/**
 * Ask for one ability or one model. At most one open request per person × item,
 * so a member who asks twice gets the request they already have rather than a
 * second card for an admin to answer.
 */
export async function requestAccess(input: {
  workspaceId: string
  userId: string
  permission?: string | null
  modelId?: string | null
  reason?: string | null
}): Promise<AccessRequestRow> {
  const permission = input.permission?.trim() || null
  const modelId = input.modelId?.trim() || null
  if (!permission === !modelId) {
    throw new AccessRequestError('Ask for exactly one ability or one model', 'invalid_request')
  }
  if (permission && !isAbilityPermissionName(permission)) {
    throw new AccessRequestError(`Unknown ability: ${permission}`, 'invalid_ability')
  }
  if (modelId && !accessModelCatalog().some((m) => m.id === modelId)) {
    throw new AccessRequestError(`Unknown model: ${modelId}`, 'invalid_model')
  }

  const open = (await loadAccessRequests(input.workspaceId)).find(
    (row) =>
      row.status === 'open' &&
      row.userId === input.userId &&
      row.permission === permission &&
      row.modelId === modelId,
  )
  if (open) return open

  const reason = input.reason?.trim().slice(0, 500) || null
  const row = (await prisma.accessAuditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      kind: 'access.requested',
      actorUserId: input.userId,
      onBehalfOfUserId: input.userId,
      permission,
      modelId,
      subject: JSON.stringify({ reason }),
    },
  })) as AuditRowLike
  await announceAccessRequest(input.workspaceId, input.userId, permission, modelId, reason)
  return toAccessRequestRow(row)
}

/**
 * Tell the workspace where admins already look. The decision itself is the
 * admin queue (`GET /access/requests` + the Settings → Access screen), not a
 * button on this message: an access grant is a policy write, and it belongs
 * with the other policy writes. Best-effort — a missing activity channel or a
 * failed post must not lose the request.
 */
async function announceAccessRequest(
  workspaceId: string,
  userId: string,
  permission: string | null,
  modelId: string | null,
  reason: string | null,
): Promise<void> {
  try {
    const channel = (await prisma.conversation.findFirst({
      where: { workspaceId, slug: 'activity' },
      select: { id: true },
    })) as { id: string } | null
    if (!channel) return

    const user = (await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    })) as { name: string | null; email: string | null } | null
    const who = user?.name || user?.email || 'A member'
    const what = permission ? `the "${permission}" ability` : `the ${modelId} model`

    const { postMessage } = await import('./conversation.service')
    await postMessage({
      conversationId: channel.id,
      text: `${who} asked for ${what}.${reason ? `\n\n"${reason}"` : ''}\n\nA workspace admin can approve or deny it in Settings → Access.`,
      authorType: 'system',
    })
  } catch (err) {
    console.warn('[access] request announcement failed:', (err as Error).message)
  }
}

/**
 * Approve or deny one request. Approving writes the item into the member's own
 * policy row (merged with whatever they already have) and audits the grant;
 * denying only audits. Both are idempotent-safe: a second decision on the same
 * request is a 409 rather than a second grant.
 */
export async function decideAccessRequest(input: {
  workspaceId: string
  requestId: string
  actorUserId: string | null
  approve: boolean
}): Promise<AccessRequestRow> {
  const request = (await prisma.accessAuditEvent.findFirst({
    where: { id: input.requestId, workspaceId: input.workspaceId, kind: 'access.requested' },
  })) as AuditRowLike | null
  if (!request) throw new AccessRequestError('No such access request', 'not_found', 404)

  const current = (await loadAccessRequests(input.workspaceId, 500)).find((row) => row.id === request.id)
  if (current && current.status !== 'open') {
    throw new AccessRequestError('That request was already decided', 'already_decided', 409)
  }

  const subjectUserId = request.onBehalfOfUserId ?? request.actorUserId
  if (input.approve && subjectUserId) {
    await grantRequestedItem(input.workspaceId, subjectUserId, request, input.actorUserId)
  }

  await recordAccessEvent({
    workspaceId: input.workspaceId,
    kind: input.approve ? 'access.granted' : 'access.denied',
    actorUserId: input.actorUserId,
    onBehalfOfUserId: subjectUserId,
    permission: request.permission,
    modelId: request.modelId,
    subject: { requestId: request.id },
  })

  return {
    ...toAccessRequestRow(request),
    status: input.approve ? 'granted' : 'denied',
    decidedByUserId: input.actorUserId,
    decidedAt: new Date().toISOString(),
  }
}

/** Merge one ability or model into a member's policy row, keeping the rest. */
async function grantRequestedItem(
  workspaceId: string,
  userId: string,
  request: AuditRowLike,
  actorUserId: string | null,
): Promise<void> {
  const existing = (await prisma.accessPolicy.findUnique({
    where: { workspaceId_subjectType_subjectId: { workspaceId, subjectType: 'member', subjectId: userId } },
  })) as Record<string, unknown> | null

  const abilities = parseJsonArray(existing?.abilities) ?? []
  const modelIds = parseJsonArray(existing?.modelIds) ?? []
  if (request.permission && !abilities.includes(request.permission)) abilities.push(request.permission)
  if (request.modelId && !modelIds.includes(request.modelId)) modelIds.push(request.modelId)

  await upsertPolicy(
    workspaceId,
    {
      subjectType: 'member',
      subjectId: userId,
      abilities: abilities.length ? abilities : null,
      modelIds: modelIds.length ? modelIds : null,
      modelTiers: parseJsonArray(existing?.modelTiers),
      defaultModelId: (existing?.defaultModelId as string | null) ?? null,
      spendCapUsd: (existing?.spendCapUsd as number | null) ?? null,
      spendPeriod: (existing?.spendPeriod as string | null) ?? null,
      requestsPerHour: (existing?.requestsPerHour as number | null) ?? null,
    },
    actorUserId,
  )
}

/** The audit trail, newest first, for the settings screen. */
export async function listAccessAudit(
  workspaceId: string,
  opts: { kind?: string; userId?: string; limit?: number } = {},
): Promise<
  Array<{
    id: string
    kind: string
    actorUserId: string | null
    onBehalfOfUserId: string | null
    permission: string | null
    modelId: string | null
    subject: Record<string, unknown>
    detail: Record<string, unknown>
    createdAt: string
  }>
> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const where: Record<string, unknown> = { workspaceId }
  if (opts.kind) where.kind = opts.kind
  if (opts.userId) where.OR = [{ actorUserId: opts.userId }, { onBehalfOfUserId: opts.userId }]

  const rows = (await prisma.accessAuditEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })) as Array<AuditRowLike & { detail: unknown }>

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId,
    onBehalfOfUserId: row.onBehalfOfUserId,
    permission: row.permission,
    modelId: row.modelId,
    subject: parseSubject(row.subject),
    detail: parseSubject(row.detail),
    createdAt: row.createdAt.toISOString(),
  }))
}
