// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Persistence for credential policies, personal connections, and grants.
 */

import { prisma } from '../../lib/prisma'
import { decryptSecret, encryptSecret } from '../../lib/secret-crypto'
import { linkIdentity, unlinkIdentity } from '../identity-links'
import {
  ACTOR_FALLBACKS,
  ACTOR_MODES,
  CHAIN_STEPS,
  chainFallback,
  defaultPolicy,
  chainMode,
  legacyChain,
  type ActorFallback,
  type ActorMode,
  type ChainStep,
  type ConnectResult,
  type CredentialPolicy,
  type PersonalConnection,
} from './types'

const db = prisma as any

const PROVIDER_RE = /^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)?$/

export function isValidProviderId(provider: string): boolean {
  return PROVIDER_RE.test(provider) && provider.length <= 200
}

function asMode(value: unknown): ActorMode {
  return ACTOR_MODES.includes(value as ActorMode) ? (value as ActorMode) : 'shared'
}

function asFallback(value: unknown): ActorFallback {
  return ACTOR_FALLBACKS.includes(value as ActorFallback) ? (value as ActorFallback) : 'ask'
}

function parseChain(value: unknown): ChainStep[] | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value)
    return validChain(parsed) ? parsed : null
  } catch {
    return null
  }
}

function validChain(value: unknown): value is ChainStep[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CHAIN_STEPS.length &&
    value.every((s) => CHAIN_STEPS.includes(s)) &&
    new Set(value).size === value.length
  )
}

function withSummaries(
  provider: string,
  writeChain: ChainStep[],
  readChain: ChainStep[],
  sharedUserId: string | null,
  delegateUserId: string | null = null,
): CredentialPolicy {
  return {
    provider,
    writeChain,
    readChain,
    writeMode: chainMode(writeChain),
    readMode: chainMode(readChain),
    fallback: chainFallback(writeChain),
    sharedUserId,
    delegateUserId,
  }
}

function toPolicy(provider: string, row: any | null): CredentialPolicy {
  if (!row) return { provider, ...defaultPolicy(provider), isDefault: true }
  const fallback = asFallback(row.fallback)
  return withSummaries(
    provider,
    parseChain(row.writeChain) ?? legacyChain(asMode(row.writeMode), fallback, 'write'),
    parseChain(row.readChain) ?? legacyChain(asMode(row.readMode), fallback, 'read'),
    row.sharedUserId ?? null,
    row.delegateUserId ?? null,
  )
}

export async function getPolicy(projectId: string, provider: string): Promise<CredentialPolicy> {
  const row = await db.integrationCredentialPolicy.findUnique({
    where: { projectId_provider: { projectId, provider } },
  })
  return toPolicy(provider, row)
}

export async function listPolicies(projectId: string): Promise<CredentialPolicy[]> {
  const rows = await db.integrationCredentialPolicy.findMany({ where: { projectId }, orderBy: { provider: 'asc' } })
  return rows.map((row: any) => toPolicy(row.provider, row))
}

export class PolicyValidationError extends Error {}

export type PolicyChanges = Partial<
  Pick<CredentialPolicy, 'writeChain' | 'readChain' | 'writeMode' | 'readMode' | 'fallback' | 'sharedUserId'>
>

/**
 * Save a policy. Chains can be set directly; the v1 fields (`writeMode`,
 * `readMode`, `fallback`) still work and are turned into the chains they
 * mean, applied on top of the current policy.
 */
export async function savePolicy(
  projectId: string,
  provider: string,
  changes: PolicyChanges,
  updatedBy: string | null,
): Promise<CredentialPolicy> {
  if (!isValidProviderId(provider)) throw new PolicyValidationError(`Unknown integration: ${provider}`)
  for (const key of ['writeMode', 'readMode'] as const) {
    if (changes[key] !== undefined && !ACTOR_MODES.includes(changes[key]!)) {
      throw new PolicyValidationError(`${key} must be one of ${ACTOR_MODES.join(', ')}`)
    }
  }
  if (changes.fallback !== undefined && !ACTOR_FALLBACKS.includes(changes.fallback)) {
    throw new PolicyValidationError(`fallback must be one of ${ACTOR_FALLBACKS.join(', ')}`)
  }
  for (const key of ['writeChain', 'readChain'] as const) {
    if (changes[key] !== undefined && !validChain(changes[key])) {
      throw new PolicyValidationError(`${key} must be a list of distinct steps from: ${CHAIN_STEPS.join(', ')}`)
    }
  }

  const current = await getPolicy(projectId, provider)
  const fallback = changes.fallback ?? current.fallback
  const legacyTouched = changes.writeMode !== undefined || changes.readMode !== undefined || changes.fallback !== undefined
  const writeChain =
    changes.writeChain ??
    (legacyTouched ? legacyChain(changes.writeMode ?? current.writeMode, fallback, 'write') : current.writeChain)
  const readChain =
    changes.readChain ??
    (legacyTouched ? legacyChain(changes.readMode ?? current.readMode, fallback, 'read') : current.readChain)
  const next = withSummaries(
    provider,
    writeChain,
    readChain,
    changes.sharedUserId !== undefined ? changes.sharedUserId : current.sharedUserId,
    current.delegateUserId,
  )

  const data = {
    writeChain: JSON.stringify(next.writeChain),
    readChain: JSON.stringify(next.readChain),
    writeMode: next.writeMode,
    readMode: next.readMode,
    fallback: next.fallback,
    sharedUserId: next.sharedUserId,
    updatedBy,
  }
  const row = await db.integrationCredentialPolicy.upsert({
    where: { projectId_provider: { projectId, provider } },
    create: { projectId, provider, ...data },
    update: data,
  })
  return toPolicy(provider, row)
}

function decryptOrNull(blob: string | null | undefined): string | null {
  return blob ? decryptSecret(blob) : null
}

function toConnection(row: any): PersonalConnection {
  return {
    userId: row.userId,
    provider: row.provider,
    externalId: row.externalId ?? null,
    externalLogin: row.externalLogin ?? null,
    accessToken: decryptOrNull(row.encryptedAccessToken),
    refreshToken: decryptOrNull(row.encryptedRefreshToken),
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt ?? null,
    scopes: row.scopes ?? null,
  }
}

export async function getPersonalConnection(userId: string, provider: string): Promise<PersonalConnection | null> {
  const row = await db.userIntegrationConnection.findUnique({ where: { userId_provider: { userId, provider } } })
  return row ? toConnection(row) : null
}

export async function savePersonalConnection(
  userId: string,
  provider: string,
  result: ConnectResult,
): Promise<void> {
  const data = {
    externalId: result.externalId ?? null,
    externalLogin: result.externalLogin ?? null,
    encryptedAccessToken: result.accessToken ? encryptSecret(result.accessToken) : null,
    encryptedRefreshToken: result.refreshToken ? encryptSecret(result.refreshToken) : null,
    accessTokenExpiresAt: result.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt ?? null,
    scopes: result.scopes ?? null,
  }
  await db.userIntegrationConnection.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, ...data },
    update: data,
  })
  if (result.externalId) {
    await linkIdentity({ userId, source: provider, externalId: result.externalId, email: result.email })
  } else {
    await unlinkIdentity(userId, provider)
  }
}

export async function deletePersonalConnection(userId: string, provider: string): Promise<void> {
  await db.userIntegrationConnection.deleteMany({ where: { userId, provider } })
  await unlinkIdentity(userId, provider)
  await db.userIntegrationGrant.updateMany({
    where: { userId, provider, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  await db.userIntegrationWorkspaceGrant.updateMany({
    where: { userId, provider, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/**
 * Make `userId` the project's delegate for `provider`, or clear it. Callers
 * check who may do this: only the person themselves opts in.
 */
export async function setDelegate(projectId: string, provider: string, userId: string | null): Promise<CredentialPolicy> {
  if (!isValidProviderId(provider)) throw new PolicyValidationError(`Unknown integration: ${provider}`)
  const current = await getPolicy(projectId, provider)
  const data = { delegateUserId: userId, delegatedAt: userId ? new Date() : null }
  const row = await db.integrationCredentialPolicy.upsert({
    where: { projectId_provider: { projectId, provider } },
    create: {
      projectId,
      provider,
      writeChain: JSON.stringify(current.writeChain),
      readChain: JSON.stringify(current.readChain),
      writeMode: current.writeMode,
      readMode: current.readMode,
      fallback: current.fallback,
      ...data,
    },
    update: data,
  })
  return toPolicy(provider, row)
}

/**
 * Which of a workspace's agents a person's workspace grant covers:
 *   own      - agents they created
 *   all      - every agent in the workspace
 *   selected - none by default; only agents allowed one by one
 */
export type WorkspaceGrantScope = 'own' | 'all' | 'selected'
export const WORKSPACE_GRANT_SCOPES: readonly WorkspaceGrantScope[] = ['own', 'all', 'selected']

export function isWorkspaceGrantScope(value: unknown): value is WorkspaceGrantScope {
  return WORKSPACE_GRANT_SCOPES.includes(value as WorkspaceGrantScope)
}

export type GrantEffect = 'allow' | 'deny'

function scopeCovers(scope: string, createdByUser: boolean): boolean {
  return scope === 'all' || (scope === 'own' && createdByUser)
}

export async function isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  const row = await db.member.findFirst({ where: { userId, workspaceId, projectId: null }, select: { id: true } })
  return !!row
}

/**
 * Whether `userId` lets this project's agent act as them on `provider`. A
 * per-project allow or deny wins; otherwise their workspace grant decides,
 * and only while they're still a member of that workspace.
 */
export async function hasActiveGrant(userId: string, projectId: string, provider: string): Promise<boolean> {
  const override = await db.userIntegrationGrant.findUnique({
    where: { userId_projectId_provider: { userId, projectId, provider } },
    select: { effect: true, revokedAt: true },
  })
  if (override && !override.revokedAt) return override.effect !== 'deny'
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true, createdBy: true } })
  if (!project) return false
  const grant = await db.userIntegrationWorkspaceGrant.findUnique({
    where: { userId_workspaceId_provider: { userId, workspaceId: project.workspaceId, provider } },
    select: { scope: true, revokedAt: true },
  })
  if (!grant || grant.revokedAt || !scopeCovers(grant.scope, project.createdBy === userId)) return false
  return isWorkspaceMember(userId, project.workspaceId)
}

export async function grantAccess(
  userId: string,
  projectId: string,
  provider: string,
  effect: GrantEffect = 'allow',
): Promise<void> {
  await db.userIntegrationGrant.upsert({
    where: { userId_projectId_provider: { userId, projectId, provider } },
    create: { userId, projectId, provider, effect },
    update: { effect, revokedAt: null },
  })
}

/** Drop a per-project allow or deny so the workspace grant decides again. */
export async function clearProjectGrant(userId: string, projectId: string, provider: string): Promise<void> {
  await db.userIntegrationGrant.updateMany({
    where: { userId, projectId, provider, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

async function clearWorkspaceOverrides(userId: string, workspaceId: string, provider: string): Promise<void> {
  await db.userIntegrationGrant.updateMany({
    where: { userId, provider, revokedAt: null, project: { workspaceId } },
    data: { revokedAt: new Date() },
  })
}

/**
 * Let agents in a workspace act as `userId` on `provider`. Changing the
 * scope resets per-agent choices in that workspace so the new scope is what
 * people see; saving the same scope again keeps them.
 */
export async function setWorkspaceGrant(
  userId: string,
  workspaceId: string,
  provider: string,
  scope: WorkspaceGrantScope,
): Promise<void> {
  const current = await db.userIntegrationWorkspaceGrant.findUnique({
    where: { userId_workspaceId_provider: { userId, workspaceId, provider } },
    select: { scope: true, revokedAt: true },
  })
  const unchanged = !!current && !current.revokedAt && current.scope === scope
  await db.userIntegrationWorkspaceGrant.upsert({
    where: { userId_workspaceId_provider: { userId, workspaceId, provider } },
    create: { userId, workspaceId, provider, scope },
    update: { scope, revokedAt: null },
  })
  if (!unchanged) await clearWorkspaceOverrides(userId, workspaceId, provider)
}

/** Stop every agent in the workspace from acting as `userId` on `provider`. */
export async function revokeWorkspaceGrant(userId: string, workspaceId: string, provider: string): Promise<void> {
  await db.userIntegrationWorkspaceGrant.updateMany({
    where: { userId, workspaceId, provider, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  await clearWorkspaceOverrides(userId, workspaceId, provider)
}

export async function getWorkspaceGrant(
  userId: string,
  workspaceId: string,
  provider: string,
): Promise<{ scope: WorkspaceGrantScope } | null> {
  const row = await db.userIntegrationWorkspaceGrant.findUnique({
    where: { userId_workspaceId_provider: { userId, workspaceId, provider } },
    select: { scope: true, revokedAt: true },
  })
  if (!row || row.revokedAt || !isWorkspaceGrantScope(row.scope)) return null
  return { scope: row.scope }
}

export interface WorkspaceAgentAccess {
  projectId: string
  name: string
  createdByMe: boolean
  /** Whether this agent acts as the person when they ask it to. */
  allowed: boolean
  /** Set when a per-agent choice overrides the workspace scope. */
  override: GrantEffect | null
}

/**
 * The workspace's agents matching `visibleWhere` (the projects the person
 * can read) and whether each may act as `userId` on `provider`.
 */
export async function listWorkspaceAgentAccess(
  userId: string,
  workspaceId: string,
  provider: string,
  visibleWhere: Record<string, unknown> = {},
): Promise<WorkspaceAgentAccess[]> {
  const [projects, grant, overrides] = await Promise.all([
    db.project.findMany({
      where: { AND: [{ workspaceId }, visibleWhere] },
      select: { id: true, name: true, createdBy: true },
      orderBy: { name: 'asc' },
    }),
    getWorkspaceGrant(userId, workspaceId, provider),
    db.userIntegrationGrant.findMany({
      where: { userId, provider, revokedAt: null, project: { workspaceId } },
      select: { projectId: true, effect: true },
    }),
  ])
  const overrideFor = new Map<string, GrantEffect>(
    overrides.map((o: { projectId: string; effect: string }) => [o.projectId, o.effect === 'deny' ? 'deny' : 'allow']),
  )
  return projects.map((p: { id: string; name: string; createdBy: string | null }) => {
    const createdByMe = p.createdBy === userId
    const override = overrideFor.get(p.id) ?? null
    const allowed = override ? override === 'allow' : !!grant && scopeCovers(grant.scope, createdByMe)
    return { projectId: p.id, name: p.name, createdByMe, allowed, override }
  })
}

export async function revokeGrant(userId: string, grantId: string): Promise<boolean> {
  const result = await db.userIntegrationGrant.updateMany({
    where: { id: grantId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count > 0
}

export interface UserIntegrationsSummary {
  connections: Array<{ provider: string; externalLogin: string | null; connectedAt: string }>
  grants: Array<{ id: string; provider: string; projectId: string; projectName: string | null; grantedAt: string }>
  workspaceGrants: Array<{
    provider: string
    workspaceId: string
    workspaceName: string | null
    scope: WorkspaceGrantScope
    grantedAt: string
  }>
}

export async function listUserIntegrations(userId: string): Promise<UserIntegrationsSummary> {
  const [connections, grants, workspaceGrants] = await Promise.all([
    db.userIntegrationConnection.findMany({ where: { userId }, orderBy: { provider: 'asc' } }),
    db.userIntegrationGrant.findMany({
      where: { userId, revokedAt: null, effect: 'allow' },
      include: { project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.userIntegrationWorkspaceGrant.findMany({
      where: { userId, revokedAt: null },
      include: { workspace: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  return {
    connections: connections.map((c: any) => ({
      provider: c.provider,
      externalLogin: c.externalLogin ?? null,
      connectedAt: new Date(c.createdAt).toISOString(),
    })),
    grants: grants.map((g: any) => ({
      id: g.id,
      provider: g.provider,
      projectId: g.projectId,
      projectName: g.project?.name ?? null,
      grantedAt: new Date(g.createdAt).toISOString(),
    })),
    workspaceGrants: workspaceGrants
      .filter((g: any) => isWorkspaceGrantScope(g.scope))
      .map((g: any) => ({
        provider: g.provider,
        workspaceId: g.workspaceId,
        workspaceName: g.workspace?.name ?? null,
        scope: g.scope,
        grantedAt: new Date(g.createdAt).toISOString(),
      })),
  }
}
