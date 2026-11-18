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
        subject: input.subject == null ? null : JSON.stringify(input.subject),
        detail: input.detail == null ? null : JSON.stringify(input.detail),
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
