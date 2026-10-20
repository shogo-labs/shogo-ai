// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tenant scoping for the cloud relay.
 *
 * The relay holds the master Zernio key, so it must never forward a caller's
 * raw operation. Every workspace shares Shogo's one Zernio account: without
 * scoping, any `shogo_sk_*` key could list every tenant's profiles or delete
 * another workspace's account. `planRelayRequest` is therefore a
 * **deny-by-default allowlist** that rewrites each permitted operation onto the
 * caller's own profile, and the route verifies the resource ids it returns.
 *
 * Scoping is derived from the caller's workspace id, never from the request:
 * `externalId` and `profileId` in a caller's body or query are discarded.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient, type SocialClient } from './client'
import { externalIdFor, getProfile, recordProfileMapping, type SocialProfileRow } from './profiles.service'
import { planRelayRequest } from './relay-plan'
import { normalizeZernioAccount, upsertAccount } from './accounts.service'
import { storeAutomation } from './automations.service'
import {
  assertSocialBudget,
  meterXPost,
  projectedConnectRawUsd,
  projectedPublishRawUsd,
} from './usage.service'

const db = prisma as any

/** Does this Zernio account belong to the workspace (locally, else live at Zernio)? */
async function accountBelongsToWorkspace(
  workspaceId: string,
  zernioAccountId: string,
  client: SocialClient,
  profile: SocialProfileRow,
): Promise<boolean> {
  const row = await db.socialAccount.findFirst({ where: { workspaceId, zernioAccountId } })
  if (row) return true
  const payload = await client.request<any>({
    method: 'GET',
    path: '/accounts',
    query: { profileId: profile.zernioProfileId },
  })
  const list = Array.isArray(payload) ? payload : (payload?.accounts ?? payload?.data ?? [])
  return list.some((account: any) => account?.id === zernioAccountId)
}

/** Does this Zernio post belong to the workspace? Every relayed create is recorded. */
async function postBelongsToWorkspace(workspaceId: string, zernioPostId: string): Promise<boolean> {
  const row = await db.socialPost.findFirst({ where: { workspaceId, zernioPostId } })
  return !!row
}

/** An automation or workflow id we recorded for this workspace (see `recordAutomation`). */
async function automationBelongsToWorkspace(
  workspaceId: string,
  zernioResourceId: string,
): Promise<boolean> {
  const row = await db.socialAutomation.findFirst({
    where: { workspaceId, zernioResourceId },
  })
  return !!row
}

async function recordAccounts(workspaceId: string, profileId: string, payload: any): Promise<void> {
  const list = Array.isArray(payload) ? payload : (payload?.accounts ?? payload?.data ?? [])
  for (const raw of list) {
    const account = normalizeZernioAccount(raw)
    if (!account) continue
    try {
      await upsertAccount(workspaceId, profileId, account)
    } catch (err) {
      // Already bound to a different workspace is the only case worth ignoring:
      // it means the provider and our rows disagree, not that this call failed.
      if (!(err instanceof SocialError) || err.status !== 409) throw err
    }
  }
}

async function recordPost(
  workspaceId: string,
  localWorkspaceId: string,
  body: any,
  payload: any,
  key: string | undefined,
): Promise<void> {
  const zernioPostId = typeof payload?.id === 'string' ? payload.id : null
  if (!zernioPostId) return
  const parsedSchedule = typeof body?.scheduledFor === 'string' ? new Date(body.scheduledFor) : null
  const scheduledFor =
    parsedSchedule && !Number.isNaN(parsedSchedule.getTime()) ? parsedSchedule : null
  const mediaUrls = Array.isArray(body?.mediaUrls) ? body.mediaUrls : []
  // Mirrors `createPost`: a draft publishes nothing, a schedule publishes later,
  // and anything else publishes now. `willPublish` is the billing condition —
  // only a leg the provider will actually put out is one X charges us for.
  const isDraft = body?.draft === true
  const publishNow = body?.publishNow === true || (!isDraft && !scheduledFor)
  const willPublish = publishNow || scheduledFor !== null

  // The relay is where a broadcast is billed, so the cloud keeps the same
  // per-account legs the desktop wrote locally: without them the `social_x_api`
  // meter has nothing to claim and an X post composed on a desktop would never
  // be charged.
  const platforms: any[] = Array.isArray(body?.platforms) ? body.platforms : []
  const providerAccountIds = platforms
    .map((platform: any) => platform?.accountId)
    .filter((id: unknown): id is string => typeof id === 'string')
  const accounts = providerAccountIds.length
    ? await db.socialAccount.findMany({
        where: { workspaceId, zernioAccountId: { in: providerAccountIds } },
        select: { id: true, zernioAccountId: true },
      })
    : []
  const byProviderId = new Map(accounts.map((account: any) => [account.zernioAccountId, account.id]))
  const targets = platforms
    .map((platform: any) => {
      const accountId = byProviderId.get(platform?.accountId)
      if (!accountId || typeof platform?.platform !== 'string') return null
      return {
        accountId,
        platform: platform.platform,
        customContent: typeof platform.customContent === 'string' ? platform.customContent : null,
        // The relay only relays the create; per-target delivery status arrives
        // on the desktop that owns the post, so a scheduled leg stays `pending`.
        status: publishNow ? 'published' : 'pending',
      }
    })
    .filter((target): target is NonNullable<typeof target> => target !== null)

  let created: any = null
  try {
    created = await db.socialPost.create({
      data: {
        workspaceId,
        status: isDraft ? 'draft' : publishNow ? 'published' : 'scheduled',
        content: typeof body?.content === 'string' ? body.content : '',
        mediaJson: mediaUrls.length ? mediaUrls : null,
        scheduledFor,
        publishedAt: publishNow ? new Date() : null,
        zernioPostId,
        // Already unique per tenant; the prefix keeps a desktop's hash from
        // colliding with a cloud-composed post.
        idempotencyKey: `relay:${workspaceId}:${localWorkspaceId}:${key ?? zernioPostId}`,
        ...(targets.length ? { targets: { create: targets } } : {}),
      },
      include: { targets: { select: { id: true, platform: true } } },
    })
  } catch (err: any) {
    // The same relayed create arriving twice is one post and one charge.
    if (err?.code !== 'P2002') throw err
    return
  }

  if (!willPublish) return
  for (const target of created?.targets ?? []) {
    if (target.platform !== 'x') continue
    await meterXPost(workspaceId, target.id)
  }
}

/**
 * Record the automation the desktop just created at Zernio.
 *
 * Same reason `recordPost` exists: the cloud is where the run webhooks land, so
 * without the row a relayed automation's executions would arrive with a
 * `workflowId` nothing here recognises — and the ownership check that stops a
 * caller editing someone else's automation has nothing to check against.
 */
async function recordAutomation(
  workspaceId: string,
  path: string,
  body: any,
  payload: any,
  localWorkspaceId: string,
): Promise<void> {
  const resource =
    payload?.automation ?? payload?.workflow ?? payload?.data ?? null
  const zernioResourceId =
    typeof resource?.id === 'string' ? resource.id : typeof payload?.id === 'string' ? payload.id : null
  if (!zernioResourceId) return

  const sequence = path.startsWith('/workflows')
  const zernioAccountId = typeof body?.accountId === 'string' ? body.accountId : ''
  const account = zernioAccountId
    ? await db.socialAccount.findFirst({
        where: { workspaceId, zernioAccountId },
        select: { id: true, platform: true },
      })
    : null
  if (!account) return

  const kind = sequence ? 'sequence' : body?.dmMessage ? 'comment_dm' : 'keyword_reply'
  const keywords = Array.isArray(body?.keywords)
    ? body.keywords.filter((value: unknown): value is string => typeof value === 'string')
    : []
  const status =
    (typeof resource?.status === 'string' && resource.status) ||
    (body?.isActive === false ? 'draft' : 'active')

  try {
    await storeAutomation({
      workspaceId,
      accountId: account.id,
      kind,
      platform: account.platform,
      name: typeof body?.name === 'string' && body.name ? body.name : 'Automation',
      mode: 'static',
      status,
      keywords,
      zernioResourceId,
      config: { ...(body ?? {}), localWorkspaceId },
    })
  } catch (err: any) {
    // The provider already created it; a duplicate relay collapses onto one row.
    if (err?.code !== 'P2002') throw err
  }
}

export interface RelayOutcome {
  status: number
  body: unknown
}

/**
 * Run one relayed operation for one scope of `workspaceId`. Resolves the
 * scope's profile, scopes the operation to it, verifies any resource id it
 * names, performs the call and records what the cloud needs for routing and
 * billing.
 *
 * `localWorkspaceId` comes from the caller's `X-Shogo-Local-Workspace` header
 * and is always read together with the workspace the key resolved to, so a
 * desktop's second local workspace gets its own profile instead of colliding
 * with the first. Resource ownership is still proved against the whole cloud
 * workspace: every local scope of a tenant belongs to that tenant.
 */
export async function relayOperation(args: {
  workspaceId: string
  localWorkspaceId?: string
  method: string
  path: string
  query: Record<string, string>
  body: any
  idempotencyKey?: string
}): Promise<RelayOutcome> {
  const localWorkspaceId = args.localWorkspaceId ?? ''
  const externalId = externalIdFor(args.workspaceId, localWorkspaceId)
  const profile = await getProfile(args.workspaceId, localWorkspaceId)
  const plan = planRelayRequest({ ...args, localWorkspaceId, externalId, profile })

  if (plan.kind === 'deny') {
    const error = new SocialError(plan.status, plan.code, plan.message)
    return { status: plan.status, body: error.toJSON() }
  }

  const client = getSocialClient()
  if (client.mode === 'relay') {
    throw new SocialError(500, 'relay_loop', 'The relay host is itself in relay mode')
  }

  if (plan.verifyAccountId) {
    if (!profile) throw new SocialError(412, 'social_not_connected', 'Connect a social account first.')
    if (!(await accountBelongsToWorkspace(args.workspaceId, plan.verifyAccountId, client, profile))) {
      return {
        status: 403,
        body: new SocialError(403, 'account_out_of_scope', 'That account belongs to another workspace.').toJSON(),
      }
    }
  }

  if (plan.verifyPostId && !(await postBelongsToWorkspace(args.workspaceId, plan.verifyPostId))) {
    return {
      status: 403,
      body: new SocialError(403, 'post_out_of_scope', 'That post belongs to another workspace.').toJSON(),
    }
  }

  if (
    plan.verifyAutomationId &&
    !(await automationBelongsToWorkspace(args.workspaceId, plan.verifyAutomationId))
  ) {
    return {
      status: 403,
      body: new SocialError(403, 'automation_out_of_scope', 'That automation belongs to another workspace.').toJSON(),
    }
  }

  // The wallet is asked before the provider is: a connect adds a monthly account
  // charge and a broadcast can carry X's per-post charge. `402` here costs the
  // user nothing; a call we then have to collect on costs us the provider bill.
  try {
    if (plan.path.startsWith('/connect/')) {
      const active = await db.socialAccount.count({
        where: { workspaceId: args.workspaceId, isActive: true },
      })
      await assertSocialBudget(args.workspaceId, projectedConnectRawUsd(active))
    } else if (plan.record === 'post-created') {
      const body: any = plan.body ?? {}
      const content = typeof body.content === 'string' ? body.content : ''
      const platforms: any[] = Array.isArray(body.platforms) ? body.platforms : []
      // A draft is never published, so it is never billed — asking the wallet
      // first would refuse to save a draft on a workspace that cannot afford a
      // post.
      const isDraft = body.draft === true
      const scheduled =
        typeof body.scheduledFor === 'string' && !Number.isNaN(new Date(body.scheduledFor).getTime())
      const publishNow = body.publishNow === true || (!isDraft && !scheduled)
      if (publishNow || scheduled) {
        await assertSocialBudget(
          args.workspaceId,
          projectedPublishRawUsd(
            platforms.map((platform: any) => ({
              platform: typeof platform?.platform === 'string' ? platform.platform : '',
              content: typeof platform?.customContent === 'string' ? platform.customContent : content,
            })),
          ),
        )
      }
    }
  } catch (err) {
    if (err instanceof SocialError) return { status: err.status, body: err.toJSON() }
    throw err
  }

  const result = await client.request<any>({
    workspaceId: args.workspaceId,
    method: args.method as any,
    path: plan.path,
    query: plan.query,
    body: plan.body,
    idempotencyKey: args.idempotencyKey,
  })

  if (plan.record === 'profile-created') {
    const zernioProfileId = typeof result?.id === 'string' ? result.id : null
    if (zernioProfileId) {
      await recordProfileMapping({
        workspaceId: args.workspaceId,
        localWorkspaceId,
        zernioProfileId,
        externalId: typeof result?.externalId === 'string' && result.externalId ? result.externalId : externalId,
      })
    }
  } else if (plan.record === 'accounts-listed' && profile) {
    await recordAccounts(args.workspaceId, profile.id, result)
  } else if (plan.record === 'post-created') {
    await recordPost(args.workspaceId, localWorkspaceId, plan.body, result, args.idempotencyKey)
  } else if (plan.record === 'automation-created') {
    await recordAutomation(args.workspaceId, plan.path, plan.body, result, localWorkspaceId)
  }

  return { status: 200, body: result ?? {} }
}
