// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Installs of external chat apps (one per workspace and provider), and the
 * links between external accounts and Shogo users.
 */

import { prisma } from '../../lib/prisma'
import { decryptSecret, encryptSecret } from '../../lib/secret-crypto'
import type { ExternalChatProvider } from '../chat-mode'
import type { ChatInstallationRecord } from './types'

const db = prisma as any

function parseJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function toInstallationRecord(row: any): ChatInstallationRecord {
  let credentials: Record<string, string> = {}
  if (row.tokensEncrypted) {
    let plain: string | null = null
    try {
      plain = decryptSecret(row.tokensEncrypted)
    } catch (err) {
      console.error(`[ChatInstallations] Could not decrypt credentials for ${row.provider} install ${row.id}:`, (err as Error).message)
    }
    if (plain !== null) {
      try {
        credentials = JSON.parse(plain)
      } catch {
        // Installs backfilled from slack_workspace_installations hold the bare bot token.
        credentials = { botToken: plain }
      }
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider,
    externalTenantId: row.externalTenantId,
    tenantName: row.tenantName ?? null,
    botUserId: row.botUserId ?? null,
    credentials,
    config: parseJson(row.config),
  }
}

export async function installationForWorkspace(workspaceId: string, provider: ExternalChatProvider): Promise<ChatInstallationRecord | null> {
  const row = await db.chatInstallation.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } })
  return row ? toInstallationRecord(row) : null
}

export async function installationForTenant(provider: ExternalChatProvider, externalTenantId: string): Promise<ChatInstallationRecord | null> {
  const row = await db.chatInstallation.findUnique({ where: { provider_externalTenantId: { provider, externalTenantId } } })
  return row ? toInstallationRecord(row) : null
}

export async function listInstallations(workspaceId: string) {
  return db.chatInstallation.findMany({
    where: { workspaceId },
    select: { id: true, provider: true, externalTenantId: true, tenantName: true, botUserId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
}

export class InstallationConflictError extends Error {}

/** Create or refresh an install. One external tenant can only belong to one Shogo workspace. */
export async function upsertInstallation(input: {
  workspaceId: string
  provider: ExternalChatProvider
  externalTenantId: string
  tenantName?: string | null
  botUserId?: string | null
  credentials?: Record<string, string>
  config?: Record<string, unknown>
  installedByUserId?: string | null
}): Promise<ChatInstallationRecord> {
  const existing = await db.chatInstallation.findUnique({
    where: { provider_externalTenantId: { provider: input.provider, externalTenantId: input.externalTenantId } },
  })
  if (existing && existing.workspaceId !== input.workspaceId) {
    throw new InstallationConflictError('That workspace is already connected to another Shogo workspace')
  }
  const data = {
    tenantName: input.tenantName ?? null,
    botUserId: input.botUserId ?? null,
    ...(input.credentials ? { tokensEncrypted: encryptSecret(JSON.stringify(input.credentials)) } : {}),
    ...(input.config ? { config: input.config } : {}),
    installedByUserId: input.installedByUserId ?? null,
  }
  await db.chatInstallation.deleteMany({
    where: { workspaceId: input.workspaceId, provider: input.provider, NOT: { externalTenantId: input.externalTenantId } },
  })
  const row = await db.chatInstallation.upsert({
    where: { provider_externalTenantId: { provider: input.provider, externalTenantId: input.externalTenantId } },
    create: { workspaceId: input.workspaceId, provider: input.provider, externalTenantId: input.externalTenantId, ...data },
    update: data,
  })
  return toInstallationRecord(row)
}

export async function mergeInstallationConfig(id: string, patch: Record<string, unknown>): Promise<void> {
  const row = await db.chatInstallation.findUnique({ where: { id }, select: { config: true } })
  if (!row) return
  await db.chatInstallation.update({ where: { id }, data: { config: { ...parseJson(row.config), ...patch } } })
}

export async function removeInstallation(workspaceId: string, provider: ExternalChatProvider): Promise<void> {
  await db.chatInstallation.deleteMany({ where: { workspaceId, provider } })
}

// ─── Identity links ──────────────────────────────────────────────────────────

export async function linkedUserId(provider: ExternalChatProvider, externalTenantId: string, externalUserId: string): Promise<string | null> {
  const link = await db.chatIdentityLink.findUnique({
    where: { provider_externalTenantId_externalUserId: { provider, externalTenantId, externalUserId } },
    select: { userId: true },
  })
  return link?.userId ?? null
}

export async function linkIdentity(input: {
  provider: ExternalChatProvider
  externalTenantId: string
  externalUserId: string
  userId: string
  displayName?: string | null
}): Promise<void> {
  await db.chatIdentityLink.upsert({
    where: {
      provider_externalTenantId_externalUserId: {
        provider: input.provider, externalTenantId: input.externalTenantId, externalUserId: input.externalUserId,
      },
    },
    create: { ...input, displayName: input.displayName ?? null },
    update: { userId: input.userId, displayName: input.displayName ?? null },
  })
}

export async function externalIdentityFor(provider: ExternalChatProvider, externalTenantId: string, userId: string) {
  return db.chatIdentityLink.findFirst({ where: { provider, externalTenantId, userId } })
}
