// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Composio toolkits ("composio:<toolkit>") as credential providers.
 *
 * Composio holds the OAuth tokens; Shogo only chooses which Composio entity a
 * tool call runs as. Personal is the requester's own entity (what every
 * Composio call used before policies existed). Shared is the entity of the
 * person the project picked (`sharedUserId`), so everyone's requests run on
 * one account.
 */

import { Composio } from '@composio/core'
import { getFrontendUrl } from '../../lib/cloud-urls'
import { prisma } from '../../lib/prisma'
import type { CredentialProvider, ResolveContext } from './types'

let client: Composio | null = null

function composio(): Composio | null {
  if (client) return client
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) return null
  client = new Composio({ apiKey, toolkitVersions: 'latest' } as any)
  return client
}

export function toolkitOf(provider: string): string {
  return provider.slice('composio:'.length).toLowerCase()
}

async function workspaceScope(workspaceId: string): Promise<'workspace' | 'project'> {
  const ws = (await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { composioScope: true } as any,
  })) as { composioScope?: string | null } | null
  return ws?.composioScope === 'project' ? 'project' : 'workspace'
}

export async function composioEntityId(ctx: Pick<ResolveContext, 'projectId' | 'workspaceId'>, userId: string): Promise<string> {
  const scope = await workspaceScope(ctx.workspaceId)
  return scope === 'workspace'
    ? `shogo_${userId}_${ctx.workspaceId}`
    : `shogo_${userId}_${ctx.workspaceId}_${ctx.projectId}`
}

/** True when `entityId` has an active connection for the toolkit, or when this API can't tell. */
async function hasConnection(entityId: string, toolkit: string): Promise<boolean> {
  const sdk = composio()
  if (!sdk) return true
  try {
    const accounts = await sdk.connectedAccounts.list({ userIds: [entityId], toolkitSlugs: [toolkit] } as any)
    const items = (accounts as any)?.items || (accounts as any)?.data || []
    return items.some((acc: any) => !acc.status || String(acc.status).toUpperCase() === 'ACTIVE')
  } catch (err: any) {
    console.warn(`[IntegrationCredentials] Composio lookup failed for ${toolkit}:`, err?.message ?? err)
    return true
  }
}

export function composioCredentialProvider(): CredentialProvider {
  return {
    id: 'composio:',
    label: (provider) => {
      const toolkit = toolkitOf(provider)
      return toolkit ? toolkit.charAt(0).toUpperCase() + toolkit.slice(1) : 'Integration'
    },
    supportsPersonal: true,

    async shared(ctx) {
      const owner = ctx.policy.sharedUserId
      if (!owner) return null
      const entityId = await composioEntityId(ctx, owner)
      return (await hasConnection(entityId, toolkitOf(ctx.provider))) ? { entityId } : null
    },

    async personalForUser(ctx, userId) {
      const entityId = await composioEntityId(ctx, userId)
      return (await hasConnection(entityId, toolkitOf(ctx.provider))) ? { entityId } : null
    },

    async beginConnect({ projectId }) {
      const url = new URL(`${getFrontendUrl().replace(/\/+$/, '')}/settings`)
      url.searchParams.set('tab', 'integrations')
      url.searchParams.set('projectId', projectId)
      return { url: url.toString() }
    },
  }
}
