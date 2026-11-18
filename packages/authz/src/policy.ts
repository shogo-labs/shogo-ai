// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pure half of workspace RBAC (SHO-417): what a member's role, groups and
 * own policy add up to.
 *
 *   ceiling  platform-visible models ∩ the workspace allow-list. Nothing widens it.
 *   grants   the role policy ∪ every group policy ∪ the member's own policy.
 *            Grants only add, so there is no precedence to reason about.
 *   effective grants ∩ ceiling.
 *
 * A role with no policy row uses the built-in default, so an existing
 * workspace sees no change on rollout. A role policy *replaces* that default
 * (that is how an admin narrows a role); group and member policies *add* to it.
 *
 * Pure: callers load the rows and the model catalog, this decides.
 */

import {
  isAbilityPermissionName,
  type AbilityPermission,
  type Permission,
} from './permissions'
import {
  WORKSPACE_ROLE_BASE_PERMISSIONS,
  WORKSPACE_ROLE_DEFAULT_ABILITIES,
  type WorkspaceRole,
} from './roles'

export type ModelTier = 'economy' | 'standard' | 'premium'

/** Cheapest first. */
export const MODEL_TIERS: readonly ModelTier[] = ['economy', 'standard', 'premium']

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

export type PolicySubjectType = 'role' | 'group' | 'member'
export type SpendPeriod = 'day' | 'week' | 'month'

export const SPEND_PERIODS: readonly SpendPeriod[] = ['day', 'week', 'month']

export function isSpendPeriod(value: unknown): value is SpendPeriod {
  return typeof value === 'string' && (SPEND_PERIODS as readonly string[]).includes(value)
}

/** One `AccessPolicy` row, as the resolver needs it. */
export interface AccessPolicyRow {
  subjectType: PolicySubjectType
  subjectId: string
  /** `null` = the role default (role rows only). */
  abilities?: readonly string[] | null
  /** `null` and `modelIds` `null` = everything under the ceiling. */
  modelTiers?: readonly string[] | null
  modelIds?: readonly string[] | null
  defaultModelId?: string | null
  spendCapUsd?: number | null
  spendPeriod?: string | null
  requestsPerHour?: number | null
}

/** A model as the resolver needs it. */
export interface ModelInfo {
  id: string
  tier: string
}

/**
 * What a set of policies grants. `tiers` and `ids` are both `null` when the
 * grant is "everything under the ceiling".
 */
export interface ModelGrant {
  tiers: ReadonlySet<ModelTier> | null
  ids: ReadonlySet<string> | null
}

export interface EffectivePolicy {
  abilities: ReadonlySet<Permission>
  models: ModelGrant
  defaultModelId: string | null
  spendCapUsd: number | null
  spendPeriod: SpendPeriod | null
  requestsPerHour: number | null
  /** Human-readable "why", e.g. `role Editor + group @ml`. */
  reasons: string[]
}

const EVERYTHING: ModelGrant = { tiers: null, ids: null }
const NOTHING: ModelGrant = { tiers: new Set(), ids: new Set() }

/**
 * A row's model grant.
 *
 * `null` in both columns means "everything under the ceiling" — the plan's
 * meaning, and what a role with no policy row gets. An explicit empty array
 * means "no models": that is how an ability-only grant is stored, so it can
 * never widen a member to every model as a side effect of asking for one
 * ability. The two are different values, not two spellings of the same one.
 */
function grantOf(row: AccessPolicyRow): ModelGrant {
  const tiers = (row.modelTiers ?? []).filter(isModelTier)
  const ids = (row.modelIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (tiers.length === 0 && ids.length === 0) {
    return row.modelTiers == null && row.modelIds == null ? EVERYTHING : NOTHING
  }
  return { tiers: new Set(tiers), ids: new Set(ids) }
}

/**
 * A row that explicitly names no models — an ability-only grant.
 *
 * `null`/`null` is *not* this: it is "everything", and skipping it would make
 * an approved model request a no-op for a member whose grant comes from their
 * role rather than a row of their own.
 */
function namesNoModels(row: AccessPolicyRow): boolean {
  if (row.modelTiers == null && row.modelIds == null) return false
  return (row.modelTiers ?? []).length === 0 && (row.modelIds ?? []).length === 0
}

function isEverything(grant: ModelGrant): boolean {
  return grant.tiers === null && grant.ids === null
}

/** Union of grants. Any "everything" grant wins, because grants only add. */
export function unionGrants(grants: readonly ModelGrant[]): ModelGrant {
  if (grants.some(isEverything)) return EVERYTHING
  const tiers = new Set<ModelTier>()
  const ids = new Set<string>()
  for (const g of grants) {
    for (const t of g.tiers ?? []) tiers.add(t)
    for (const id of g.ids ?? []) ids.add(id)
  }
  return { tiers, ids }
}

/** The abilities a role, its groups and the member's own policy add up to. */
export function resolveAbilities(
  role: WorkspaceRole,
  policies: readonly AccessPolicyRow[],
): Set<Permission> {
  const abilities = new Set<Permission>()
  for (const p of WORKSPACE_ROLE_BASE_PERMISSIONS[role]) abilities.add(p)

  const rolePolicy = policies.find((p) => p.subjectType === 'role' && p.subjectId === role)
  const roleAbilities: readonly string[] =
    rolePolicy?.abilities != null ? rolePolicy.abilities : WORKSPACE_ROLE_DEFAULT_ABILITIES[role]
  for (const a of roleAbilities) if (isAbilityPermissionName(a)) abilities.add(a)

  for (const p of policies) {
    if (p.subjectType === 'role') continue
    for (const a of p.abilities ?? []) if (isAbilityPermissionName(a)) abilities.add(a)
  }
  return abilities
}

/** The model grant a role, its groups and the member's own policy add up to. */
export function resolveModelGrant(
  role: WorkspaceRole,
  policies: readonly AccessPolicyRow[],
): ModelGrant {
  const rolePolicy = policies.find((p) => p.subjectType === 'role' && p.subjectId === role)
  const grants: ModelGrant[] = [rolePolicy ? grantOf(rolePolicy) : EVERYTHING]
  for (const p of policies) {
    if (p.subjectType === 'role') continue
    // A group or member row that names no models grants abilities only. Reading
    // its empty model columns as "everything" would let an ability request
    // silently widen the member to every model in the workspace.
    if (namesNoModels(p)) continue
    grants.push(grantOf(p))
  }
  return unionGrants(grants)
}

/** Whether `model` is inside the grant and the ceiling. */
export function isModelAllowed(
  grant: ModelGrant,
  model: ModelInfo,
  ceiling: ReadonlySet<string> | null,
): boolean {
  if (ceiling !== null && !ceiling.has(model.id)) return false
  if (isEverything(grant)) return true
  if (grant.ids?.has(model.id)) return true
  return grant.tiers?.has(model.tier as ModelTier) ?? false
}

/** Every model in `catalog` the grant allows under `ceiling`, catalog order kept. */
export function allowedModels(
  grant: ModelGrant,
  ceiling: ReadonlySet<string> | null,
  catalog: readonly ModelInfo[],
): ModelInfo[] {
  return catalog.filter((m) => isModelAllowed(grant, m, ceiling))
}

function tierRank(tier: string): number {
  const index = MODEL_TIERS.indexOf(tier as ModelTier)
  return index === -1 ? 0 : index
}

/**
 * The model a member runs on when nobody picked one, or when the picked one is
 * outside their grant: the highest-tier allowed model, catalog order breaking
 * ties. `null` when nothing is allowed.
 */
export function highestTierAllowed(
  grant: ModelGrant,
  ceiling: ReadonlySet<string> | null,
  catalog: readonly ModelInfo[],
): string | null {
  let best: ModelInfo | null = null
  for (const m of allowedModels(grant, ceiling, catalog)) {
    if (!best || tierRank(m.tier) > tierRank(best.tier)) best = m
  }
  return best?.id ?? null
}

/**
 * The member's default model: their own policy, then a group policy (highest
 * tier wins), then the role policy, then the workspace default — each only if
 * it is inside the effective set. Falls back to the highest-tier allowed model.
 */
export function resolveDefaultModelId(opts: {
  role: WorkspaceRole
  policies: readonly AccessPolicyRow[]
  grant: ModelGrant
  ceiling: ReadonlySet<string> | null
  catalog: readonly ModelInfo[]
  workspaceDefaultModelId?: string | null
}): string | null {
  const { role, policies, grant, ceiling, catalog } = opts
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const allowed = (id: string | null | undefined): string | null => {
    if (!id) return null
    const model = byId.get(id)
    return model && isModelAllowed(grant, model, ceiling) ? id : null
  }

  const memberPolicy = policies.find((p) => p.subjectType === 'member')
  const fromMember = allowed(memberPolicy?.defaultModelId)
  if (fromMember) return fromMember

  const groupDefaults = policies
    .filter((p) => p.subjectType === 'group')
    .map((p) => allowed(p.defaultModelId))
    .filter((id): id is string => !!id)
  if (groupDefaults.length > 0) {
    return groupDefaults.reduce((best, id) =>
      tierRank(byId.get(id)?.tier ?? '') > tierRank(byId.get(best)?.tier ?? '') ? id : best,
    )
  }

  const rolePolicy = policies.find((p) => p.subjectType === 'role' && p.subjectId === role)
  const fromRole = allowed(rolePolicy?.defaultModelId)
  if (fromRole) return fromRole

  const fromWorkspace = allowed(opts.workspaceDefaultModelId)
  if (fromWorkspace) return fromWorkspace

  return highestTierAllowed(grant, ceiling, catalog)
}

/**
 * The tightest spend cap and rate limit across the member's policies. Caps are
 * ceilings, so the lowest non-null value wins; the period comes from the row
 * that supplied the cap.
 */
export function resolveLimits(policies: readonly AccessPolicyRow[]): {
  spendCapUsd: number | null
  spendPeriod: SpendPeriod | null
  requestsPerHour: number | null
} {
  let spendCapUsd: number | null = null
  let spendPeriod: SpendPeriod | null = null
  let requestsPerHour: number | null = null
  for (const p of policies) {
    if (typeof p.spendCapUsd === 'number' && p.spendCapUsd >= 0) {
      if (spendCapUsd === null || p.spendCapUsd < spendCapUsd) {
        spendCapUsd = p.spendCapUsd
        spendPeriod = isSpendPeriod(p.spendPeriod) ? p.spendPeriod : 'month'
      }
    }
    if (typeof p.requestsPerHour === 'number' && p.requestsPerHour >= 0) {
      if (requestsPerHour === null || p.requestsPerHour < requestsPerHour) {
        requestsPerHour = p.requestsPerHour
      }
    }
  }
  return { spendCapUsd, spendPeriod, requestsPerHour }
}

/**
 * Everything the resolver decides, from the rows it was given.
 *
 * `models:use_all` is honoured here rather than at each call site: it replaces
 * the role/group/member grant with "everything", and the ceiling is still
 * applied on top by `isModelAllowed`, so the ability can never widen what the
 * workspace allows. That is the whole point of the switch — an owner or admin
 * who is narrowed by a role policy can still reach every model the workspace
 * has, and nothing beyond it.
 */
export function resolvePolicy(opts: {
  role: WorkspaceRole
  policies: readonly AccessPolicyRow[]
  ceiling: ReadonlySet<string> | null
  catalog: readonly ModelInfo[]
  workspaceDefaultModelId?: string | null
  reasons?: readonly string[]
}): EffectivePolicy {
  const abilities = resolveAbilities(opts.role, opts.policies)
  const models = abilities.has('models:use_all')
    ? EVERYTHING
    : resolveModelGrant(opts.role, opts.policies)
  const limits = resolveLimits(opts.policies)
  return {
    abilities,
    models,
    defaultModelId: resolveDefaultModelId({
      role: opts.role,
      policies: opts.policies,
      grant: models,
      ceiling: opts.ceiling,
      catalog: opts.catalog,
      workspaceDefaultModelId: opts.workspaceDefaultModelId,
    }),
    ...limits,
    reasons: [...(opts.reasons ?? [])],
  }
}

/** The abilities a role has with no policy rows at all (the rollout default). */
export function defaultAbilitiesFor(role: WorkspaceRole): readonly AbilityPermission[] {
  return WORKSPACE_ROLE_DEFAULT_ABILITIES[role]
}
