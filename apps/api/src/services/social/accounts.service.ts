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
import { ensureProfile, getProfile } from './profiles.service'
import { localScopeFor } from './local-scope'
import { zernioId } from './provider-ids'
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
  const id = zernioId(raw)
  const platform = typeof raw?.platform === 'string' ? raw.platform.toLowerCase() : ''
  // Zernio returns the handle as the person typed it (`@acme`); our UI already
  // prints the `@`, so storing one doubles it.
  const username =
    typeof raw?.username === 'string' ? raw.username.trim().replace(/^@+/, '') : ''
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

export async function listAccounts(workspaceId: string, projectId?: string | null): Promise<any[]> {
  return db.socialAccount.findMany({
    where: accountScope(workspaceId, projectId),
    orderBy: [{ isActive: 'desc' }, { platform: 'asc' }, { username: 'asc' }],
  })
}

/**
 * The accounts a caller may use.
 *
 * A **project** caller sees the accounts it owns plus the workspace-shared ones
 * (`projectId: null`). The **workspace agent** and the **Social page** pass no
 * project and see everything. Every reader goes through this instead of a bare
 * `{ workspaceId }`, so a project's agent can never post to, read the inbox of,
 * or automate another project's account.
 */
export function accountScope(workspaceId: string, projectId?: string | null): Record<string, unknown> {
  if (!projectId) return { workspaceId }
  return { workspaceId, OR: [{ projectId }, { projectId: null }] }
}

/**
 * The account ids a caller may use, or `null` when it may use every account in
 * the workspace. Inbox threads, comments and automations hang off an account, so
 * this is how they are scoped without repeating the query in each service.
 */
export async function scopedAccountIds(
  workspaceId: string,
  projectId?: string | null,
): Promise<string[] | null> {
  if (!projectId) return null
  const rows = await db.socialAccount.findMany({
    where: accountScope(workspaceId, projectId),
    select: { id: true },
  })
  return rows.map((row: any) => row.id as string)
}

/**
 * Whether one already-fetched row is visible to a caller scoped to `projectId`.
 * Used where a query is simpler as `{ workspaceId, id }` and the scope is a
 * one-row check, so no caller has to build a nested `AND`.
 */
export function inAccountScope(
  row: { projectId?: string | null },
  projectId?: string | null,
): boolean {
  if (!projectId) return true
  return !row.projectId || row.projectId === projectId
}

/**
 * Upsert one account row from a provider payload. Used by sync, the connect
 * redirect and (later) `account.connected` webhooks, so re-running it is safe.
 *
 * `projectId` is the owner to stamp on a **new** row. An existing row keeps its
 * owner: a sync reconciles the whole profile, so it must not be able to move an
 * account another project already owns. `claim` is the explicit-connect case —
 * a connect that lands on an account owned by a different project is refused
 * rather than silently returning that project's row.
 */
export async function upsertAccount(
  workspaceId: string,
  profileId: string,
  account: ZernioAccount,
  opts: { projectId?: string | null; claim?: boolean } = {},
) {
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
    if (opts.claim && opts.projectId && existing.projectId && existing.projectId !== opts.projectId) {
      throw new SocialError(
        409,
        'account_owned_elsewhere',
        'That account is connected to another project in this workspace.',
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
      projectId: opts.projectId ?? null,
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
export async function syncProfileAccounts(
  profile: {
    id: string
    workspaceId: string
    zernioProfileId: string
  },
  projectId?: string | null,
  opts: { claim?: boolean } = {},
): Promise<ZernioAccount[]> {
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
    // A row this sync creates belongs to the caller's project; a row that
    // already exists keeps its owner (see `upsertAccount`). `claim` is only set
    // by the sync that completes a connect the caller just started — a routine
    // refresh must not fail because the workspace holds another project's
    // account.
    await upsertAccount(profile.workspaceId, profile.id, account, {
      projectId,
      claim: opts.claim,
    })
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

/**
 * Pull the current scope's accounts from Zernio and reconcile our rows.
 *
 * A scope with no profile yet has nothing to sync: asking the provider would
 * mean creating a profile for a workspace that has never connected anything,
 * and a brand-new workspace has zero of both. Only a connect creates a profile.
 */
export async function syncAccounts(
  workspaceId: string,
  workspaceName: string,
  projectId?: string | null,
  opts: { claim?: boolean } = {},
): Promise<any[]> {
  const scope = await localScopeFor(workspaceId)
  const profile = await getProfile(workspaceId, scope)
  if (!profile) return listAccounts(workspaceId, projectId)
  await syncProfileAccounts(profile, projectId, opts)
  return listAccounts(workspaceId, projectId)
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
async function reconnectTarget(
  workspaceId: string,
  raw: unknown,
  projectId?: string | null,
): Promise<string | undefined> {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const value = raw.trim()
  const row = await db.socialAccount.findFirst({
    where: { workspaceId, OR: [{ id: value }, { zernioAccountId: value }] },
    select: { zernioAccountId: true, projectId: true },
  })
  if (!row || !inAccountScope(row, projectId)) {
    throw new SocialError(400, 'unknown_account', 'That account does not belong to this workspace.')
  }
  return row.zernioAccountId as string
}

/**
 * How Zernio signs an Instagram account in. `instagram_login` is the default and
 * the only one Shogo ever sent before; `facebook_login` goes through a Facebook
 * Page linked to the account, and it is the only way Meta serves the licensed
 * music catalog (`GET /accounts/:id/instagram/audio`).
 */
export const INSTAGRAM_LOGIN_METHODS = ['instagram_login', 'facebook_login'] as const
export type InstagramLoginMethod = (typeof INSTAGRAM_LOGIN_METHODS)[number]

/**
 * The login method a connect asked for, or undefined when it did not ask.
 *
 * Only Instagram has two: every other platform ignores the parameter rather than
 * failing, because a caller that sends it for a whole fan-out should not have to
 * special-case the platforms that do not understand it.
 */
export function parseLoginMethod(platform: string, raw: unknown): InstagramLoginMethod | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (platform !== 'instagram') return undefined
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!(INSTAGRAM_LOGIN_METHODS as readonly string[]).includes(value)) {
    throw new SocialError(
      400,
      'invalid_login_method',
      `loginMethod must be one of: ${INSTAGRAM_LOGIN_METHODS.join(', ')}`,
    )
  }
  return value as InstagramLoginMethod
}

/**
 * Carry the owning project through the OAuth round trip as our own param on the
 * redirect URL. Zernio keeps unknown params, so the return page (and anything
 * that later reads the callback) can tell which project the connect was for.
 * The row itself is stamped by the sync that follows, which is the only path
 * that can prove whose workspace the account belongs to.
 */
function withProjectParam(redirectUrl: string, projectId?: string | null): string {
  if (!projectId) return redirectUrl
  try {
    const url = new URL(redirectUrl)
    url.searchParams.set('projectId', projectId)
    return url.toString()
  } catch {
    return redirectUrl
  }
}

/**
 * The URL to send the user to so Zernio can run the platform's OAuth and land
 * back on `redirectUrl` with `accountId` + `username`.
 *
 * `forceReauth` (Instagram only) makes Instagram show its own login page instead
 * of reusing whichever account is already signed in on the device, and
 * `expectedHandle` refuses a login that lands on a different account — together
 * they are what makes "connect *this* Instagram account" mean something.
 * `loginMethod` (Instagram only) picks Instagram Login or Facebook Login; the
 * latter is what a Reel with licensed music needs.
 */
export async function connectUrl(args: {
  workspaceId: string
  workspaceName: string
  platform: unknown
  redirectUrl: string
  forceReauth?: unknown
  expectedUsername?: unknown
  reconnectAccountId?: unknown
  loginMethod?: unknown
  /** The project the account will belong to. `null`/omitted = workspace-shared. */
  projectId?: string | null
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

  const reconnect = await reconnectTarget(args.workspaceId, args.reconnectAccountId, args.projectId)

  // A second Instagram connect must not silently re-land on the account that is
  // already signed in on the device: Instagram Login reuses it, the callback
  // brings back the same `accountId`, and `upsertAccount` updates that row — so
  // the person sees their "new" account refused or replaced. Defaulting
  // `forceReauth` on makes Instagram show its own login page, from the UI, the
  // agent tool and the relay alike. A reconnect is the one case that *wants* the
  // existing account, so it is left alone.
  const forceReauth =
    args.forceReauth === true ||
    (platform === 'instagram' &&
      !reconnect &&
      (await db.socialAccount.count({
        where: { workspaceId: args.workspaceId, platform: 'instagram', isActive: true },
      })) > 0)

  const query: Record<string, string> = {
    profileId: profile.zernioProfileId,
    redirect_url: withProjectParam(args.redirectUrl, args.projectId),
  }
  // Instagram Login only; Zernio ignores it elsewhere, and sending it to a
  // platform that does not understand it is a param its OAuth state would carry
  // for nothing (X caps that state at 500 characters).
  if (platform === 'instagram' && forceReauth) query.forceReauth = 'true'
  const loginMethod = parseLoginMethod(platform, args.loginMethod)
  if (loginMethod) query.loginMethod = loginMethod
  const handle = expectedHandle(args.expectedUsername)
  if (handle) query.expectedUsername = handle
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
  projectId?: string | null
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
  // `claim`: this is an explicit connect, so landing on an account another
  // project already owns is refused instead of quietly returning that row.
  return upsertAccount(args.workspaceId, profile.id, account, {
    projectId: args.projectId ?? null,
    claim: true,
  })
}

/** Remove the account at Zernio (stops the per-account charge) and retire the row. */
export async function disconnectAccount(
  workspaceId: string,
  accountRowId: string,
  projectId?: string | null,
): Promise<any> {
  const row = await db.socialAccount.findFirst({ where: { id: accountRowId, workspaceId } })
  if (!row || !inAccountScope(row, projectId)) {
    throw new SocialError(404, 'account_not_found', 'Account not found')
  }

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

/**
 * Move an account between projects, or back to workspace-shared (`null`).
 *
 * No provider call: the Zernio account does not move, only who may use it. The
 * caller has already checked that `projectId` is a project of this workspace.
 */
export async function moveAccount(
  workspaceId: string,
  accountRowId: string,
  projectId: string | null,
): Promise<any> {
  const row = await db.socialAccount.findFirst({ where: { id: accountRowId, workspaceId } })
  if (!row) throw new SocialError(404, 'account_not_found', 'Account not found')
  return db.socialAccount.update({
    where: { id: row.id },
    data: { projectId: projectId ?? null },
  })
}
