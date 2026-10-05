// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Persistence for credential policies, personal connections, and grants.
 */

import { prisma } from '../../lib/prisma'
import { decryptSecret, encryptSecret } from '../../lib/secret-crypto'
import {
  ACTOR_FALLBACKS,
  ACTOR_MODES,
  CHAIN_STEPS,
  DEFAULT_POLICY,
  chainFallback,
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

function withSummaries(provider: string, writeChain: ChainStep[], readChain: ChainStep[], sharedUserId: string | null): CredentialPolicy {
  return {
    provider,
    writeChain,
    readChain,
    writeMode: chainMode(writeChain),
    readMode: chainMode(readChain),
    fallback: chainFallback(writeChain),
    sharedUserId,
  }
}

function toPolicy(provider: string, row: any | null): CredentialPolicy {
  if (!row) return { provider, ...DEFAULT_POLICY }
  const fallback = asFallback(row.fallback)
  return withSummaries(
    provider,
    parseChain(row.writeChain) ?? legacyChain(asMode(row.writeMode), fallback, 'write'),
    parseChain(row.readChain) ?? legacyChain(asMode(row.readMode), fallback, 'read'),
    row.sharedUserId ?? null,
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
}

export async function deletePersonalConnection(userId: string, provider: string): Promise<void> {
  await db.userIntegrationConnection.deleteMany({ where: { userId, provider } })
  await db.userIntegrationGrant.updateMany({
    where: { userId, provider, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export async function hasActiveGrant(userId: string, projectId: string, provider: string): Promise<boolean> {
  const row = await db.userIntegrationGrant.findUnique({
    where: { userId_projectId_provider: { userId, projectId, provider } },
    select: { revokedAt: true },
  })
  return !!row && !row.revokedAt
}

export async function grantAccess(userId: string, projectId: string, provider: string): Promise<void> {
  await db.userIntegrationGrant.upsert({
    where: { userId_projectId_provider: { userId, projectId, provider } },
    create: { userId, projectId, provider },
    update: { revokedAt: null },
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
}

export async function listUserIntegrations(userId: string): Promise<UserIntegrationsSummary> {
  const [connections, grants] = await Promise.all([
    db.userIntegrationConnection.findMany({ where: { userId }, orderBy: { provider: 'asc' } }),
    db.userIntegrationGrant.findMany({
      where: { userId, revokedAt: null },
      include: { project: { select: { name: true } } },
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
  }
}
