// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Connected platform accounts for a workspace.
 *
 * Zernio bills per connected account, so rows are never hard-deleted on
 * disconnect — `isActive` goes false and the row keeps its history (posts,
 * targets) intact. The only hard delete is removing the account from Zernio
 * itself, which stops the charge.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'
import { ensureProfile } from './profiles.service'
import { assertSocialBudget, projectedConnectRawUsd } from './usage.service'

const db = prisma as any

const PLATFORM_SLUG = /^[a-z][a-z0-9_]{1,24}$/

export function parsePlatform(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!PLATFORM_SLUG.test(value)) {
    throw new SocialError(400, 'invalid_platform', 'platform must be a Zernio platform slug, e.g. instagram')
  }
  return value
}

/** `{ accounts: [...] }`, `{ data: [...] }` or a bare array. */
function accountList(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.accounts)) return payload.accounts
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

export interface ZernioAccount {
  id: string
  platform: string
  username: string
  displayName?: string | null
  tokenHealthy?: boolean | null
  needsReconnect?: boolean | null
}

export function normalizeZernioAccount(raw: any): ZernioAccount | null {
  const id = raw?.id ?? raw?.accountId
  const platform = typeof raw?.platform === 'string' ? raw.platform.toLowerCase() : ''
  const username = typeof raw?.username === 'string' ? raw.username : ''
  if (typeof id !== 'string' || !id || !platform || !username) return null
  return {
    id,
    platform,
    username,
    displayName: typeof raw?.displayName === 'string' ? raw.displayName : null,
    tokenHealthy: typeof raw?.tokenHealthy === 'boolean' ? raw.tokenHealthy : undefined,
    needsReconnect: typeof raw?.needsReconnect === 'boolean' ? raw.needsReconnect : undefined,
  }
}

export async function listAccounts(workspaceId: string): Promise<any[]> {
  return db.socialAccount.findMany({
    where: { workspaceId },
    orderBy: [{ isActive: 'desc' }, { platform: 'asc' }, { username: 'asc' }],
  })
}

/**
 * Upsert one account row from a provider payload. Used by sync, the connect
 * redirect and (later) `account.connected` webhooks, so re-running it is safe.
 */
export async function upsertAccount(workspaceId: string, profileId: string, account: ZernioAccount) {
  const existing = await db.socialAccount.findUnique({ where: { zernioAccountId: account.id } })
  const health = {
    isActive: true,
    needsReconnect: account.needsReconnect ?? false,
    tokenHealthy: account.tokenHealthy ?? true,
    lastHealthAt: new Date(),
  }
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      throw new SocialError(
        409,
        'account_owned_elsewhere',
        'That account is already connected to another workspace.',
      )
    }
    return db.socialAccount.update({
      where: { id: existing.id },
      data: {
        profileId,
        platform: account.platform,
        username: account.username,
        displayName: account.displayName ?? existing.displayName,
        ...health,
      },
    })
  }
  return db.socialAccount.create({
    data: {
      workspaceId,
      profileId,
      zernioAccountId: account.id,
      platform: account.platform,
      username: account.username,
      displayName: account.displayName ?? null,
      ...health,
    },
  })
}

/**
 * Reconcile **one profile's** accounts against the provider.
 *
 * Scoped by `profileId` rather than by workspace, because a cloud workspace owns
 * several profiles (one per local workspace of the desktop) and the monthly
 * sweep has to reconcile each of them: an account that exists only at Zernio —
 * a desktop that connected and then never synced — is still billed, and a stale
 * local row must not be able to hide it from the sweep.
 */
export async function syncProfileAccounts(profile: {
  id: string
  workspaceId: string
  zernioProfileId: string
}): Promise<ZernioAccount[]> {
  const payload = await getSocialClient().request<any>({
    workspaceId: profile.workspaceId,
    method: 'GET',
    path: '/accounts',
    query: { profileId: profile.zernioProfileId },
  })
  const remote = accountList(payload)
    .map(normalizeZernioAccount)
    .filter((account): account is ZernioAccount => !!account)

  for (const account of remote) {
    await upsertAccount(profile.workspaceId, profile.id, account)
  }

  const seen = new Set(remote.map((account) => account.id))
  const ours = await db.socialAccount.findMany({
    where: { profileId: profile.id, isActive: true },
    select: { id: true, zernioAccountId: true },
  })
  for (const row of ours) {
    if (seen.has(row.zernioAccountId)) continue
    await db.socialAccount.update({
      where: { id: row.id },
      data: { isActive: false, tokenHealthy: false, needsReconnect: true, lastHealthAt: new Date() },
    })
  }
  return remote
}

/** Pull the current scope's accounts from Zernio and reconcile our rows. */
export async function syncAccounts(workspaceId: string, workspaceName: string): Promise<any[]> {
  const profile = await ensureProfile(workspaceId, workspaceName)
  await syncProfileAccounts(profile)
  return listAccounts(workspaceId)
}

/**
 * A handle a caller wants the connect to land on, normalised: Zernio compares it
 * case-insensitively and ignores a leading `@`.
 */
function expectedHandle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const handle = raw.trim().replace(/^@+/, '')
  return /^[A-Za-z0-9._-]{1,64}$/.test(handle) ? handle : ''
}

/**
 * The account a reconnect is meant to refresh. Zernio wants its own account id,
 * so a caller may pass either that or one of our row ids and this resolves it —
 * an id we cannot find in this workspace is refused rather than forwarded.
 */
async function reconnectTarget(workspaceId: string, raw: unknown): Promise<string | undefined> {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const value = raw.trim()
  const row = await db.socialAccount.findFirst({
    where: { workspaceId, OR: [{ id: value }, { zernioAccountId: value }] },
    select: { zernioAccountId: true },
  })
  if (!row) {
    throw new SocialError(400, 'unknown_account', 'That account does not belong to this workspace.')
  }
  return row.zernioAccountId as string
}

/**
 * The URL to send the user to so Zernio can run the platform's OAuth and land
 * back on `redirectUrl` with `accountId` + `username`.
 *
 * `forceReauth` (Instagram only) makes Instagram show its own login page instead
 * of reusing whichever account is already signed in on the device, and
 * `expectedHandle` refuses a login that lands on a different account — together
 * they are what makes "connect *this* Instagram account" mean something.
 */
export async function connectUrl(args: {
  workspaceId: string
  workspaceName: string
  platform: unknown
  redirectUrl: string
  forceReauth?: unknown
  expectedUsername?: unknown
  reconnectAccountId?: unknown
}): Promise<{ url: string; platform: string; profileId: string }> {
  const platform = parsePlatform(args.platform)
  const profile = await ensureProfile(args.workspaceId, args.workspaceName)

  // Every connected account is a monthly charge, and the band is decided by how
  // many the workspace has — so the wallet is asked before the user is sent
  // through a platform's OAuth only to have the account refused afterwards.
  // A no-op on a desktop and on BYOK, where Zernio bills the user directly.
  const activeAccounts = await db.socialAccount.count({
    where: { workspaceId: args.workspaceId, isActive: true },
  })
  await assertSocialBudget(args.workspaceId, projectedConnectRawUsd(activeAccounts))

  const query: Record<string, string> = {
    profileId: profile.zernioProfileId,
    redirect_url: args.redirectUrl,
  }
  // Instagram Login only; Zernio ignores it elsewhere, and sending it to a
  // platform that does not understand it is a param its OAuth state would carry
  // for nothing (X caps that state at 500 characters).
  if (platform === 'instagram' && args.forceReauth === true) query.forceReauth = 'true'
  const handle = expectedHandle(args.expectedUsername)
  if (handle) query.expectedUsername = handle
  const reconnect = await reconnectTarget(args.workspaceId, args.reconnectAccountId)
  if (reconnect) query.reconnectAccountId = reconnect

  const payload = await getSocialClient().request<any>({
    workspaceId: args.workspaceId,
    method: 'GET',
    path: `/connect/${platform}`,
    query,
  })

  // Zernio answers `{ authUrl }`. The other spellings are kept because the
  // relay and older mocks in this repo answer with them.
  const url =
    (typeof payload?.authUrl === 'string' && payload.authUrl) ||
    (typeof payload?.url === 'string' && payload.url) ||
    (typeof payload?.connectUrl === 'string' && payload.connectUrl) ||
    (typeof payload?.data?.authUrl === 'string' && payload.data.authUrl) ||
    (typeof payload?.data?.url === 'string' && payload.data.url) ||
    (typeof payload === 'string' ? payload : '')

  if (!url) {
    throw new SocialError(502, 'connect_url_missing', 'Zernio did not return a connect URL.')
  }
  return { url, platform, profileId: profile.id }
}

/**
 * Record the account the OAuth redirect came back with. The callback already
 * carries `accountId` + `username`, so this costs no provider call and gives
 * the user their account before the next sync.
 */
export async function completeConnect(args: {
  workspaceId: string
  workspaceName: string
  platform: unknown
  accountId: string
  username: string
  displayName?: string | null
}): Promise<any> {
  const platform = parsePlatform(args.platform)
  const profile = await ensureProfile(args.workspaceId, args.workspaceName)
  const account = normalizeZernioAccount({
    id: args.accountId,
    platform,
    username: args.username,
    displayName: args.displayName ?? null,
  })
  if (!account) {
    throw new SocialError(400, 'invalid_account', 'accountId and username are required')
  }
  return upsertAccount(args.workspaceId, profile.id, account)
}

/** Remove the account at Zernio (stops the per-account charge) and retire the row. */
export async function disconnectAccount(workspaceId: string, accountRowId: string): Promise<any> {
  const row = await db.socialAccount.findFirst({ where: { id: accountRowId, workspaceId } })
  if (!row) throw new SocialError(404, 'account_not_found', 'Account not found')

  if (row.isActive) {
    await getSocialClient().request({
      workspaceId,
      method: 'DELETE',
      path: `/accounts/${encodeURIComponent(row.zernioAccountId)}`,
    })
  }

  return db.socialAccount.update({
    where: { id: row.id },
    data: { isActive: false, tokenHealthy: false, needsReconnect: false, lastHealthAt: new Date() },
  })
}
