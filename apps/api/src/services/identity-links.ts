// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which account on another platform belongs to which Shogo user.
 *
 * Links come from places where the platform itself told us who the person
 * is: a personal OAuth connection (GitHub returns the user id), a sign-in
 * account (better-auth `accounts`, same provider ids), or a Composio
 * "who am I" action run with the person's own connection. Nothing a
 * webhook payload claims ever creates a link.
 *
 * Lookups only answer when exactly one member of the workspace matches; an
 * ambiguous match is treated as no match.
 */

import { prisma } from '../lib/prisma'

const db = prisma as any

export type IdentitySource = string

/** Record that `userId` is `externalId` on `source`, replacing their older account there. */
export async function linkIdentity(input: {
  userId: string
  source: IdentitySource
  externalId: string
  email?: string | null
}): Promise<void> {
  const externalId = String(input.externalId).trim()
  if (!externalId) return
  const email = input.email ? String(input.email).trim().toLowerCase() || null : null
  await db.userIdentityLink.deleteMany({
    where: { userId: input.userId, source: input.source, NOT: { externalId } },
  })
  await db.userIdentityLink.upsert({
    where: { userId_source_externalId: { userId: input.userId, source: input.source, externalId } },
    create: { userId: input.userId, source: input.source, externalId, email },
    update: { email },
  })
}

export async function unlinkIdentity(userId: string, source: IdentitySource): Promise<void> {
  await db.userIdentityLink.deleteMany({ where: { userId, source } })
}

export async function listIdentityLinks(userId: string): Promise<Array<{ source: string; externalId: string; email: string | null; updatedAt: Date }>> {
  return db.userIdentityLink.findMany({
    where: { userId },
    select: { source: true, externalId: true, email: true, updatedAt: true },
    orderBy: { source: 'asc' },
  })
}

async function onlyMember(workspaceId: string, userIds: string[]): Promise<string | null> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return null
  const members = await db.member.findMany({
    where: { workspaceId, userId: { in: unique } },
    select: { userId: true },
  })
  const memberIds = [...new Set(members.map((m: { userId: string }) => m.userId))]
  return memberIds.length === 1 ? (memberIds[0] as string) : null
}

/** The workspace member who is `externalId` on `source`, if exactly one is. */
export async function findLinkedMember(
  workspaceId: string,
  source: IdentitySource,
  externalId: string,
): Promise<string | null> {
  const id = String(externalId).trim()
  if (!id) return null
  const [links, accounts] = await Promise.all([
    db.userIdentityLink.findMany({ where: { source, externalId: id }, select: { userId: true } }),
    db.account.findMany({ where: { providerId: source, accountId: id }, select: { userId: true } }),
  ])
  return onlyMember(workspaceId, [...links, ...accounts].map((r: { userId: string }) => r.userId))
}

/**
 * The workspace member with this email, if exactly one is. Matches verified
 * Shogo emails (stored lowercase by better-auth) and emails a platform
 * reported for a linked account.
 */
export async function findMemberByEmail(workspaceId: string, email: string): Promise<string | null> {
  const normalized = String(email).trim().toLowerCase()
  if (!normalized || !normalized.includes('@')) return null
  const [users, links] = await Promise.all([
    db.user.findMany({ where: { email: normalized, emailVerified: true }, select: { id: true } }),
    db.userIdentityLink.findMany({ where: { email: normalized }, select: { userId: true } }),
  ])
  return onlyMember(workspaceId, [
    ...users.map((u: { id: string }) => u.id),
    ...links.map((l: { userId: string }) => l.userId),
  ])
}

// ─── Composio "who am I" ────────────────────────────────────────────────

/** The slice of the Composio SDK this needs. */
export interface ComposioIdentityClient {
  connectedAccounts: {
    list(query: { userIds: string[]; toolkitSlugs?: string[] }): Promise<unknown>
  }
  tools: {
    getRawComposioTools(query: { toolkits: string[]; limit?: number }): Promise<unknown>
    execute(slug: string, body: { userId: string; arguments: Record<string, unknown>; dangerouslySkipVersionCheck?: boolean }): Promise<unknown>
  }
}

let identityClient: ComposioIdentityClient | null | undefined

/** Test seam; `undefined` restores the real SDK client. */
export function setComposioIdentityClient(client: ComposioIdentityClient | null | undefined): void {
  identityClient = client
  lastLinkAttempt.clear()
}

async function composioClient(): Promise<ComposioIdentityClient | null> {
  if (identityClient !== undefined) return identityClient
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) return null
  const { Composio } = await import('@composio/core')
  return new Composio({ apiKey }) as unknown as ComposioIdentityClient
}

const WHOAMI_PATTERNS = [
  /_WHO_?AM_?I$/,
  /_GET_(THE_)?(AUTHENTICATED|CURRENT|LOGGED_IN)_USER(_INFO|_PROFILE|_DETAILS)?$/,
  /_GET_(MY|CURRENT)_(USER|PROFILE|ACCOUNT|SELF)(_INFO|_DETAILS)?$/,
  /_GET_(ME|MYSELF|SELF|VIEWER)$/,
  /_(GET|FETCH|RETRIEVE)_USER_?INFO$/,
  /_AUTH_TEST$/,
]

interface RawTool {
  slug: string
  input_parameters?: { required?: string[] }
  inputParameters?: { required?: string[] }
}

/** The toolkit's "who am I" action: a name match that needs no arguments. */
export function pickWhoAmITool(tools: RawTool[]): string | null {
  for (const pattern of WHOAMI_PATTERNS) {
    const hit = tools.find((t) => {
      const required = t.input_parameters?.required ?? t.inputParameters?.required ?? []
      return pattern.test(String(t.slug).toUpperCase()) && required.length === 0
    })
    if (hit) return hit.slug
  }
  return null
}

const ID_KEYS = ['accountId', 'account_id', 'user_id', 'userId', 'id', 'gid', 'login']
const EMAIL_KEYS = ['email', 'emailAddress', 'email_address', 'mail', 'primaryEmail']
const CONTAINER_KEYS = ['data', 'response_data', 'user', 'viewer', 'me', 'profile', 'account', 'result']

/** Pull an account id and email out of a "who am I" response, nearest first. */
export function identityFromWhoAmI(response: unknown): { externalId: string; email: string | null } | null {
  let queue: unknown[] = [response]
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next: unknown[] = []
    for (const node of queue) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue
      const obj = node as Record<string, unknown>
      const idKey = ID_KEYS.find((k) => typeof obj[k] === 'string' || typeof obj[k] === 'number')
      if (idKey && depth > 0) {
        const emailKey = EMAIL_KEYS.find((k) => typeof obj[k] === 'string' && String(obj[k]).includes('@'))
        return { externalId: String(obj[idKey]), email: emailKey ? String(obj[emailKey]) : null }
      }
      for (const k of CONTAINER_KEYS) if (obj[k] && typeof obj[k] === 'object') next.push(obj[k])
    }
    queue = next
  }
  return null
}

async function activeEntity(client: ComposioIdentityClient, entityIds: string[], toolkit: string): Promise<string | null> {
  for (const entityId of entityIds) {
    const res = await client.connectedAccounts.list({ userIds: [entityId], toolkitSlugs: [toolkit] })
    const items = ((res as any)?.items ?? (res as any)?.data ?? []) as Array<{ status?: string }>
    if (items.some((a) => String(a.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE')) return entityId
  }
  return null
}

const LINK_RETRY_MS = 6 * 60 * 60 * 1000
const lastLinkAttempt = new Map<string, number>()

/**
 * Ask Composio who `userId` is on `toolkit` using their own connection, and
 * link it. Best effort: toolkits without a recognizable action are skipped.
 */
export async function linkComposioIdentity(input: {
  userId: string
  toolkit: string
  /** The user's own Composio entity ids, most specific first. */
  entityIds: string[]
}): Promise<{ linked: boolean; externalId?: string; tool?: string }> {
  const toolkit = input.toolkit.toLowerCase()
  const key = `${input.userId}:${toolkit}`
  const now = Date.now()
  if ((lastLinkAttempt.get(key) ?? 0) > now - LINK_RETRY_MS) return { linked: false }
  lastLinkAttempt.set(key, now)

  const client = await composioClient()
  if (!client) return { linked: false }
  try {
    const entityId = await activeEntity(client, input.entityIds, toolkit)
    if (!entityId) return { linked: false }
    const raw = await client.tools.getRawComposioTools({ toolkits: [toolkit], limit: 500 })
    const tools = (Array.isArray(raw) ? raw : (raw as any)?.items ?? []) as RawTool[]
    const slug = pickWhoAmITool(tools)
    if (!slug) return { linked: false }
    const result = await client.tools.execute(slug, {
      userId: entityId,
      arguments: {},
      dangerouslySkipVersionCheck: true,
    })
    if ((result as any)?.successful === false) return { linked: false, tool: slug }
    const identity = identityFromWhoAmI(result)
    if (!identity) return { linked: false, tool: slug }
    await linkIdentity({ userId: input.userId, source: `composio:${toolkit}`, ...identity })
    return { linked: true, externalId: identity.externalId, tool: slug }
  } catch (err: any) {
    console.warn(`[IdentityLinks] who-am-I for ${toolkit} failed:`, err?.message ?? err)
    return { linked: false }
  }
}
