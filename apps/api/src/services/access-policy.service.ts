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
import { getRbacMode } from '../lib/authz/mode'
import { AUTO_MODEL_ID } from '@shogo/model-catalog'
import { getMergedCatalogSync } from './model-registry.service'
import { getAllowedModelIds, isModelVisibleForWorkspace } from './workspace-models.service'
import { getAgentDefaultModel } from './workspace-agent.service'
import type { MessageBlocks, QuestionBlock } from './conversation-message-kind'

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
 *
 * This sits on the hot path of every proxied request, so it never throws: a
 * read that fails returns `null`, the caller falls back to the workspace
 * ceiling (today's behaviour) and an ability check fails closed. A 500 here
 * would take down every model call in the workspace because one row was
 * unreadable.
 */
export async function getEffectiveAccess(
  workspaceId: string,
  userId: string,
): Promise<EffectiveAccess | null> {
  const key = cacheKey(workspaceId, userId)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.loadedAt <= CACHE_TTL_MS) return cached.value

  try {
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
  } catch (err) {
    console.warn('[access] effective access read failed:', (err as Error)?.message ?? err)
    return null
  }
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

/**
 * The model gate for one request, as a decision rather than a response.
 *
 * `allowed: false` means the acting person may not use `modelId` and the caller
 * should refuse with `code`. In `shadow` mode the decision is `allowed: true`
 * and a `shadow_denied` row is written, so an admin can tune policies before
 * enforcing.
 *
 * The workspace ceiling never depends on a member row. When there is no
 * effective access — a guest, a stale id, or a read that failed — the allowlist
 * check that shipped before RBAC still runs, so a workspace that hid a model
 * keeps hiding it. Only the per-person grant needs a member row.
 */
export async function checkModelAccess(
  workspaceId: string,
  userId: string | null | undefined,
  modelId: string,
  context: { projectId?: string | null; actorUserId?: string | null } = {},
): Promise<
  | { allowed: true }
  | { allowed: false; code: 'model_not_allowed' | 'model_not_visible'; message: string }
> {
  const access = userId ? await getEffectiveAccess(workspaceId, userId) : null

  if (!access) {
    if (await isModelVisibleForWorkspace(workspaceId, modelId)) return { allowed: true }
    return {
      allowed: false,
      code: 'model_not_visible',
      message: `Model '${modelId}' is not available in this workspace.`,
    }
  }

  if (await isModelAllowedFor(workspaceId, userId!, modelId)) return { allowed: true }

  // A model outside the workspace allowlist is a ceiling denial, not a policy
  // one: the person could not have it whatever their role granted.
  const outsideCeiling = access.ceiling !== null && !access.ceiling.has(modelId)
  const code = outsideCeiling ? 'model_not_visible' : 'model_not_allowed'

  const mode = await getRbacMode()
  await recordAccessEvent({
    workspaceId,
    kind: mode === 'on' ? 'denied' : 'shadow_denied',
    actorUserId: context.actorUserId ?? null,
    onBehalfOfUserId: userId,
    modelId,
    permission: 'models:use_all',
    detail: { projectId: context.projectId ?? null, mode, role: access.role, code },
  })
  if (mode !== 'on') {
    console.warn('[rbac] shadow-deny model', { workspaceId, userId, modelId, role: access.role })
    return { allowed: true }
  }
  return {
    allowed: false,
    code,
    message: outsideCeiling
      ? `Model '${modelId}' is not available in this workspace.`
      : `Your role can't use ${modelId}. Ask a workspace admin for access.`,
  }
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
 *
 * `auto` is a routing sentinel, not a model: it is always allowed, and the
 * capping happens in the narrowed `autoTiers` map the runtime receives. Treating
 * it as a model would downgrade every Auto run and tell the person a false
 * reason ("your role can't use auto").
 */
export async function resolveRunModelFor(
  workspaceId: string,
  userId: string,
  configuredModel: string,
): Promise<{ model: string; downgrade: { from: string; to: string } | null } | null> {
  const access = await getEffectiveAccess(workspaceId, userId)
  if (!access) return null
  if (configuredModel === AUTO_MODEL_ID) return { model: AUTO_MODEL_ID, downgrade: null }
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
  /**
   * Grant every model under the ceiling. Only meaningful for a group or member
   * row: a write that names no models is stored as "no models" (an ability-only
   * grant), so "everything" has to be asked for rather than inferred from an
   * empty field. A role row needs no flag — `null`/`null` is its default.
   */
  grantsAllModels?: boolean
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

  // A group or member row that names no models is an ability-only grant, and it
  // is stored as an explicit empty array. `null`/`null` keeps its one meaning —
  // "everything under the ceiling" — so an ability grant can never widen a
  // member to every model, and an approved model request is never a no-op.
  if (write.subjectType !== 'role' && !write.grantsAllModels) {
    const namesNoModels =
      (write.modelTiers?.length ?? 0) === 0 && (write.modelIds?.length ?? 0) === 0
    if (namesNoModels) {
      data.modelTiers = [] as never
      data.modelIds = [] as never
    }
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
  await announceAccessRequest(input.workspaceId, input.userId, permission, modelId, reason, row.id)
  return toAccessRequestRow(row)
}

/**
 * Ask the workspace admins, where they already look: a decision card in the
 * workspace activity channel, with Approve / Deny on it. Answering the card is
 * what decides the request (see `applyAccessRequestAnswer`), so the card and the
 * admin queue in Settings → Access are two views of one decision, not two
 * paths. Best-effort — a missing activity channel or a failed post must not
 * lose the request, which is already an audit row.
 */
async function announceAccessRequest(
  workspaceId: string,
  userId: string,
  permission: string | null,
  modelId: string | null,
  reason: string | null,
  requestId: string,
): Promise<void> {
  try {
    const channel = (await prisma.conversation.findFirst({
      where: { workspaceId, slug: 'activity' },
    })) as Record<string, any> | null
    if (!channel) return

    const admins = (await prisma.member.findMany({
      where: { workspaceId, projectId: null, role: { in: ['owner', 'admin'] } },
      select: { userId: true },
    })) as Array<{ userId: string }>
    const adminIds = admins.map((m) => m.userId).filter((id) => id !== userId)

    const user = (await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    })) as { name: string | null; email: string | null } | null
    const who = user?.name || user?.email || 'A member'
    const what = permission ? `the "${permission}" ability` : `the ${modelId} model`

    const { newQuestionId, onQuestionAsked } = await import('./conversation-questions')
    const { postMessage } = await import('./conversation.service')
    const { afterMessagePosted } = await import('./conversation-pipeline')

    const question: QuestionBlock = {
      id: newQuestionId(),
      to: { userIds: adminIds, anyone: adminIds.length === 0, via: 'channel' },
      header: 'Access request',
      prompt: `${who} asked for ${what}.${reason ? ` "${reason}"` : ''} Approve it?`,
      interaction: 'choice',
      options: [
        { label: 'Approve', description: `Grant ${what} to ${who}.` },
        { label: 'Deny', description: 'Leave their access as it is.' },
      ],
      status: 'open',
      source: 'inferred',
      askCount: 1,
      lastAskedAt: new Date().toISOString(),
    }
    const blocks: MessageBlocks = {
      questions: [question],
      accessRequest: { requestId, workspaceId, permission, modelId },
      messageKind: 'decision',
    }
    const posted = await postMessage({
      conversationId: channel.id,
      authorType: 'system',
      systemMentions: true,
      text: `${adminIds.map((id) => `<@u:${id}> `).join('')}**Access request:** ${who} asked for ${what}.`,
      blocks,
    })
    await onQuestionAsked({ ...posted.row, blocks }, channel, question).catch((err: Error) =>
      console.warn('[access] request card notify failed:', err.message),
    )
    void afterMessagePosted(posted, { actorUserId: null, origin: 'system' })
  } catch (err) {
    console.warn('[access] request announcement failed:', (err as Error).message)
  }
}

/**
 * What an admin chose on an access request's card. Applied where every other
 * answer lands (`answerQuestion`), so the card and the queue cannot disagree.
 * A second answer is refused by `decideAccessRequest` itself (409).
 */
export async function applyAccessRequestAnswer(input: {
  requestId: string
  workspaceId: string
  answer: string
  userId: string
}): Promise<void> {
  const approve = /^approve/i.test(input.answer.trim())
  await decideAccessRequest({
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    actorUserId: input.userId,
    approve,
  })
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

/**
 * Merge one ability or model into a member's policy row, keeping the rest.
 *
 * The model side merges into the member's **effective** grant — role ∪ groups ∪
 * their own row — and writes the union explicitly. Reading only their own row
 * made the approval a no-op for anyone whose access came from their role: with
 * no row of their own the old code wrote `null`/`null`, which means "everything"
 * and is skipped as an ability-only grant, so the member still could not use the
 * model they had just been granted.
 *
 * A member who already has every model keeps their row untouched: the approval
 * adds nothing, and rewriting it would either widen or narrow a grant the admin
 * set deliberately.
 */
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
  if (request.permission && !abilities.includes(request.permission)) abilities.push(request.permission)

  const effective = await getEffectiveAccess(workspaceId, userId)
  const grant = effective?.models ?? { tiers: null, ids: null }
  const grantsEverything = grant.tiers === null && grant.ids === null

  let modelIds = parseJsonArray(existing?.modelIds)
  let modelTiers = parseJsonArray(existing?.modelTiers)
  // Only a row that already exists and already means "everything" is preserved
  // as such. A member with no row of their own has no model grant to keep, so
  // their new row must not invent one.
  const rowGrantsEverything = existing !== null && modelIds === null && modelTiers === null

  const writesExplicitModels = Boolean(request.modelId) && !grantsEverything
  if (writesExplicitModels) {
    modelIds = [...(grant.ids ?? [])]
    modelTiers = [...(grant.tiers ?? [])]
    if (!modelIds.includes(request.modelId!)) modelIds.push(request.modelId!)
  }

  await upsertPolicy(
    workspaceId,
    {
      subjectType: 'member',
      subjectId: userId,
      abilities: abilities.length ? abilities : [],
      modelIds,
      modelTiers,
      // Preserve a row that already means "everything"; otherwise the write is
      // an ability-only grant and is stored as "no models", so approving an
      // ability can never hand out every model.
      grantsAllModels: !writesExplicitModels && rowGrantsEverything,
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

/**
 * What `shadow` mode would have blocked, grouped per person and per item.
 *
 * This is the number an admin needs before flipping `rbac_enforce` to `on`: a
 * role that would block a hundred calls a day is a policy to fix, not a switch
 * to throw. Counted from the audit rows themselves, so it can never disagree
 * with the trail below it.
 */
export async function summarizeShadowDenials(
  workspaceId: string,
  opts: { days?: number } = {},
): Promise<
  Array<{
    userId: string | null
    permission: string | null
    modelId: string | null
    count: number
    lastAt: string
  }>
> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = (await prisma.accessAuditEvent.findMany({
    where: { workspaceId, kind: 'shadow_denied', createdAt: { gte: since } },
    select: {
      onBehalfOfUserId: true,
      actorUserId: true,
      permission: true,
      modelId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 5_000,
  })) as Array<{
    onBehalfOfUserId: string | null
    actorUserId: string | null
    permission: string | null
    modelId: string | null
    createdAt: Date
  }>

  const grouped = new Map<string, { userId: string | null; permission: string | null; modelId: string | null; count: number; lastAt: string }>()
  for (const row of rows) {
    const userId = row.onBehalfOfUserId ?? row.actorUserId ?? null
    const key = `${userId ?? ''}|${row.permission ?? ''}|${row.modelId ?? ''}`
    const seen = grouped.get(key)
    if (seen) {
      seen.count += 1
      continue
    }
    grouped.set(key, {
      userId,
      permission: row.permission,
      modelId: row.modelId,
      count: 1,
      lastAt: row.createdAt.toISOString(),
    })
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count)
}
