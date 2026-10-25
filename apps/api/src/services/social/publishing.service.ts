// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publishing: one composed post fanned out to many accounts.
 *
 * A post is ours first and Zernio's second — the row and its per-account
 * targets are written before the provider call, so a failed or partial publish
 * is visible per target instead of vanishing into a toast. Post status is
 * derived from the targets: all published → `published`, some → `partial`,
 * none → `failed`.
 */

import { createHash } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'
import { ensureProfile } from './profiles.service'
import { zernioId } from './provider-ids'
import { assertSocialBudget, meterXPost, projectedPublishRawUsd } from './usage.service'

const db = prisma as any

export const POST_STATUSES = [
  'draft',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'partial',
  'failed',
] as const

export type PostStatus = (typeof POST_STATUSES)[number]

export interface PostVariant {
  content?: string
  mediaUrls?: string[]
  /**
   * Zernio's per-target settings, passed through as `platformSpecificData`:
   * a YouTube title, a TikTok privacy level, a LinkedIn reshare and so on.
   */
  platformSpecificData?: Record<string, unknown>
}

export interface CreatePostInput {
  content?: unknown
  accountIds?: unknown
  variants?: Record<string, PostVariant>
  mediaUrls?: unknown
  scheduledFor?: unknown
  publishNow?: boolean
  draft?: boolean
  tags?: unknown
  /** TikTok settings applied to every TikTok target (`tiktokSettings`). */
  tiktok?: unknown
  createdByUserId?: string | null
}

/** What Zernio calls a media entry: a public URL plus what kind of file it is. */
export interface ZernioMediaItem {
  url: string
  type?: string
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  gif: 'gif',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  heic: 'image',
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
  webm: 'video',
  avi: 'video',
  mpeg: 'video',
  mpg: 'video',
  pdf: 'document',
}

/**
 * `type` for a media URL, from its extension. Zernio infers it when absent but
 * rejects a type that contradicts the extension, so an unknown extension is left
 * for the provider to decide rather than guessed at.
 */
export function mediaTypeFor(url: string): string | undefined {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {}
  const match = /\.([A-Za-z0-9]+)$/.exec(path.split('?')[0] ?? path)
  return match ? MEDIA_TYPE_BY_EXTENSION[match[1]!.toLowerCase()] : undefined
}

/** One media URL in the shape Zernio reads. */
function mediaItem(url: string): ZernioMediaItem {
  const type = mediaTypeFor(url)
  return type ? { url, type } : { url }
}

/**
 * The `platformSpecificData` one target is dispatched with.
 *
 * TikTok is the reason this exists: a TikTok target with no direct-publish
 * settings goes to the creator's inbox as a draft, which is the safe default —
 * direct publish would need `privacyLevel` and the two consent flags, so only a
 * caller that supplied a privacy level gets it.
 */
export function platformDataFor(
  platform: string,
  variant: Record<string, unknown> | undefined,
  tiktok: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = { ...(variant ?? {}) }
  if (platform !== 'tiktok') return Object.keys(data).length ? data : undefined

  const variantSettings =
    data.tiktokSettings && typeof data.tiktokSettings === 'object'
      ? (data.tiktokSettings as Record<string, unknown>)
      : {}
  const settings: Record<string, unknown> = { ...(tiktok ?? {}), ...variantSettings }
  if (typeof settings.privacyLevel !== 'string' || !settings.privacyLevel) {
    settings.draft = true
  }
  data.tiktokSettings = settings
  return data
}

function stringList(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new SocialError(400, 'invalid_body', `${field} must be a list of strings`)
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new SocialError(400, 'invalid_body', `${field} must be a list of non-empty strings`)
    }
    out.push(value.trim())
  }
  return out
}

function parseScheduledFor(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null
  const date = raw instanceof Date ? raw : new Date(String(raw))
  if (Number.isNaN(date.getTime())) {
    throw new SocialError(400, 'invalid_body', 'scheduledFor must be an ISO timestamp')
  }
  return date
}

/**
 * Stable per (workspace, content, schedule, targets). Immediate posts bucket by
 * the minute so a double submit dedupes but two deliberate posts an hour apart
 * do not collide.
 */
export function postIdempotencyKey(
  workspaceId: string,
  input: { content: string; accountIds: string[]; scheduledFor: Date | null; mediaUrls: string[] },
  now: Date = new Date(),
): string {
  const when = input.scheduledFor
    ? input.scheduledFor.toISOString()
    : new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()
  const canonical = JSON.stringify({
    workspaceId,
    content: input.content,
    when,
    accounts: [...input.accountIds].sort(),
    media: input.mediaUrls,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

async function loadAccounts(workspaceId: string, accountIds: string[]) {
  const accounts = await db.socialAccount.findMany({
    where: { workspaceId, id: { in: accountIds } },
  })
  const found = new Map(accounts.map((account: any) => [account.id, account]))
  const missing = accountIds.filter((id) => !found.has(id))
  if (missing.length) {
    throw new SocialError(400, 'unknown_account', `Unknown account(s): ${missing.join(', ')}`)
  }
  const inactive = accounts.filter((account: any) => !account.isActive)
  if (inactive.length) {
    throw new SocialError(
      409,
      'account_inactive',
      `Reconnect ${inactive.map((account: any) => `@${account.username}`).join(', ')} before publishing.`,
    )
  }
  return accounts
}

/** Platforms that refuse a post with no image or video. */
const MEDIA_ONLY_PLATFORMS = new Set(['instagram', 'tiktok'])

/**
 * Refuse a text-only post aimed at a platform that cannot publish one.
 *
 * Media can be supplied two ways — on the post (`mediaUrls`) for every target,
 * or on a variant (`variants[accountId].mediaUrls`) for one — so a target counts
 * as having media if either is non-empty.
 */
function requireMedia(
  accounts: any[],
  variants: Record<string, any>,
  mediaUrls: string[],
): void {
  const missing = accounts
    .filter((account) => MEDIA_ONLY_PLATFORMS.has(account.platform))
    .filter((account) => {
      const variantMedia = variants[account.id]?.mediaUrls
      return mediaUrls.length === 0 && !(Array.isArray(variantMedia) && variantMedia.length > 0)
    })
    .map((account) => `${account.platform} @${account.username}`)
  if (missing.length === 0) return
  throw new SocialError(
    400,
    'media_required',
    `${missing.join(', ')} needs a photo or video — Instagram and TikTok do not publish text-only posts.`,
  )
}

export async function createPost(workspaceId: string, workspaceName: string, input: CreatePostInput) {
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  const mediaUrls = stringList(input.mediaUrls, 'mediaUrls')
  const tags = stringList(input.tags, 'tags')
  const isDraft = input.draft === true

  if (!isDraft && !content && mediaUrls.length === 0) {
    throw new SocialError(400, 'empty_post', 'A post needs text or media')
  }

  const accountIds = stringList(input.accountIds, 'accountIds')
  if (!isDraft && accountIds.length === 0) {
    throw new SocialError(400, 'no_targets', 'Pick at least one account to publish to')
  }

  const scheduledFor = parseScheduledFor(input.scheduledFor)
  const publishNow = input.publishNow === true || (!isDraft && !scheduledFor)
  if (!isDraft && !publishNow && scheduledFor && scheduledFor.getTime() <= Date.now()) {
    throw new SocialError(400, 'invalid_schedule', 'scheduledFor must be in the future')
  }

  const variants = input.variants && typeof input.variants === 'object' ? input.variants : {}
  const accounts = accountIds.length ? await loadAccounts(workspaceId, accountIds) : []

  // Instagram and TikTok have no text-only post. Refusing here costs nothing;
  // finding out from the provider costs a publish attempt that fails per target
  // and leaves the person with a post full of red rows.
  if (!isDraft) {
    requireMedia(accounts, variants, mediaUrls)
  }

  const status: PostStatus = isDraft ? 'draft' : publishNow ? 'publishing' : 'scheduled'
  const idempotencyKey = postIdempotencyKey(workspaceId, { content, accountIds, scheduledFor, mediaUrls })

  const existing = await db.socialPost.findUnique({ where: { idempotencyKey } })
  if (existing) return getPost(workspaceId, existing.id)

  const post = await db.socialPost.create({
    data: {
      workspaceId,
      status,
      content,
      mediaJson: mediaUrls.length ? mediaUrls : null,
      scheduledFor: publishNow ? null : scheduledFor,
      idempotencyKey,
      createdByUserId: input.createdByUserId ?? null,
      tags,
      targets: {
        create: accounts.map((account: any) => {
          const variant = variants[account.id] ?? {}
          const variantMedia = Array.isArray(variant.mediaUrls) ? variant.mediaUrls : []
          return {
            accountId: account.id,
            platform: account.platform,
            customContent: typeof variant.content === 'string' && variant.content.trim() ? variant.content : null,
            mediaJson: variantMedia.length ? variantMedia : null,
          }
        }),
      },
    },
  })

  if (isDraft) return getPost(workspaceId, post.id)

  const platformData = new Map<string, Record<string, unknown>>()
  const tiktok =
    input.tiktok && typeof input.tiktok === 'object' ? (input.tiktok as Record<string, unknown>) : undefined
  for (const account of accounts) {
    const variant = variants[account.id] as Record<string, unknown> | undefined
    const data = platformDataFor(
      account.platform,
      variant?.platformSpecificData && typeof variant.platformSpecificData === 'object'
        ? (variant.platformSpecificData as Record<string, unknown>)
        : undefined,
      tiktok,
    )
    if (data) platformData.set(account.id, data)
  }

  try {
    await dispatchPost(workspaceId, workspaceName, post.id, { publishNow, platformSpecificData: platformData })
  } catch (err) {
    await markPostFailed(post.id, err)
    throw err
  }
  return getPost(workspaceId, post.id)
}

function detailOf(err: unknown): { message: string; details: Record<string, unknown> } {
  if (err instanceof SocialError) return { message: err.message, details: err.details }
  return { message: err instanceof Error ? err.message : String(err), details: {} }
}

async function markPostFailed(postId: string, err: unknown) {
  const { message } = detailOf(err)
  await db.socialPost.update({ where: { id: postId }, data: { status: 'failed' } }).catch(() => {})
  await db.socialPostTarget
    .updateMany({
      where: { postId, status: { in: ['pending', 'publishing'] } },
      data: { status: 'failed', error: message },
    })
    .catch(() => {})
}

/**
 * Send one post to Zernio and fold the per-target result back onto the rows.
 * `platforms[]` carries our per-account variants; Zernio answers with the same
 * targets, whose failures never abort their siblings.
 */
export async function dispatchPost(
  workspaceId: string,
  workspaceName: string,
  postId: string,
  opts: {
    publishNow?: boolean
    /** Per-account-row platform settings, resolved by `createPost`. */
    platformSpecificData?: Map<string, Record<string, unknown>>
  } = {},
) {
  const post = await db.socialPost.findFirst({
    where: { id: postId, workspaceId },
    include: { targets: { include: { account: true } } },
  })
  if (!post) throw new SocialError(404, 'post_not_found', 'Post not found')
  if (post.targets.length === 0) {
    throw new SocialError(400, 'no_targets', 'This post has no target accounts')
  }

  const profile = await ensureProfile(workspaceId, workspaceName)
  const media = Array.isArray(post.mediaJson) ? (post.mediaJson as string[]) : []
  const publishNow = opts.publishNow === true || (!post.scheduledFor && post.status === 'publishing')

  const platforms = post.targets.map((target: any) => {
    const targetMedia = Array.isArray(target.mediaJson) ? (target.mediaJson as string[]) : null
    const platformData = opts.platformSpecificData?.get(target.accountId)
    return {
      accountId: target.account.zernioAccountId,
      platform: target.platform,
      ...(target.customContent ? { customContent: target.customContent } : {}),
      // Zernio takes `customMedia` per target; `mediaUrls` is not a field it
      // reads, so a per-account override sent that way was silently dropped.
      ...(targetMedia && targetMedia.length
        ? { customMedia: targetMedia.map((url) => mediaItem(url)) }
        : {}),
      ...(platformData ? { platformSpecificData: platformData } : {}),
    }
  })

  const body: Record<string, unknown> = {
    profileId: profile.zernioProfileId,
    content: post.content,
    platforms,
    ...(media.length ? { mediaItems: media.map((url) => mediaItem(url)) } : {}),
  }
  if (publishNow) body.publishNow = true
  else if (post.scheduledFor) body.scheduledFor = post.scheduledFor.toISOString()
  else body.draft = true

  // X bills per post and 13× more when the post carries a link, so the wallet is
  // asked before the call: a `402` here costs nothing, whereas a publish the
  // wallet cannot cover costs a provider charge we then have to collect. A draft
  // publishes nothing and is not pre-flighted.
  if (publishNow || post.scheduledFor) {
    await assertSocialBudget(
      workspaceId,
      projectedPublishRawUsd(
        post.targets.map((target: any) => ({
          platform: target.platform,
          content: target.customContent ?? post.content,
        })),
      ),
    )
  }

  if (publishNow) {
    await db.socialPost.update({ where: { id: post.id }, data: { status: 'publishing' } })
    await db.socialPostTarget.updateMany({
      where: { postId: post.id, status: 'pending' },
      data: { status: 'publishing' },
    })
  }

  const result = await getSocialClient().request<any>({
    workspaceId,
    method: 'POST',
    path: '/posts',
    body,
    idempotencyKey: post.idempotencyKey,
  })

  const providerTargets: any[] = Array.isArray(result?.targets)
    ? result.targets
    : Array.isArray(result?.platforms)
      ? result.platforms
      : []
  const byProviderAccount = new Map(
    providerTargets
      .filter((t: any) => typeof (t?.accountId ?? t?.account_id) === 'string')
      .map((t: any) => [t.accountId ?? t.account_id, t]),
  )

  for (const target of post.targets) {
    const remote = byProviderAccount.get(target.account.zernioAccountId)
    if (!remote) continue
    const failed = remote.status === 'failed' || !!remote.error
    await db.socialPostTarget.update({
      where: { id: target.id },
      data: {
        status: failed ? 'failed' : remote.status === 'pending' ? 'publishing' : 'published',
        platformPostId:
          typeof remote.postId === 'string' ? remote.postId : zernioId(remote),
        platformPostUrl: typeof remote.url === 'string' ? remote.url : typeof remote.postUrl === 'string' ? remote.postUrl : null,
        error: failed ? String(remote.error ?? remote.platformError ?? 'Publish failed') : null,
      },
    })
  }

  // A provider answer with no per-target detail means it accepted the whole
  // post; keep the rows truthful rather than leaving them stuck on `publishing`.
  if (publishNow && providerTargets.length === 0) {
    await db.socialPostTarget.updateMany({
      where: { postId: post.id, status: 'publishing' },
      data: { status: 'published' },
    })
  }

  const targets = await db.socialPostTarget.findMany({ where: { postId: post.id }, select: { status: true } })
  const published = targets.filter((t: any) => t.status === 'published').length
  const failed = targets.filter((t: any) => t.status === 'failed').length

  const status: PostStatus = !publishNow
    ? 'scheduled'
    : published === 0 && failed > 0
      ? 'failed'
      : failed > 0
        ? 'partial'
        : published > 0
          ? 'published'
          : 'queued'

  await db.socialPost.update({
    where: { id: post.id },
    data: {
      status,
      zernioPostId: zernioId(result, 'post'),
      publishedAt: status === 'published' || status === 'partial' ? new Date() : null,
    },
  })

  // X charges the moment it accepts the post — published now or scheduled for
  // later — so a leg the provider did not reject is billable. Every other
  // platform is free per post and `meterXPost` is a no-op for it.
  if (publishNow || post.scheduledFor) {
    for (const target of post.targets) {
      if (target.platform !== 'x') continue
      await meterXPost(workspaceId, target.id)
    }
  }

  return getPost(workspaceId, post.id)
}

export async function listPosts(
  workspaceId: string,
  opts: { status?: string | null; from?: Date | null; to?: Date | null; limit?: number } = {},
) {
  const where: Record<string, unknown> = { workspaceId }
  if (opts.status) where.status = opts.status
  if (opts.from || opts.to) {
    const range: Record<string, unknown> = {}
    if (opts.from) range.gte = opts.from
    if (opts.to) range.lte = opts.to
    where.OR = [{ scheduledFor: range }, { publishedAt: range }]
  }
  return db.socialPost.findMany({
    where,
    include: { targets: { include: { account: { select: { id: true, username: true, platform: true } } } } },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  })
}

export async function getPost(workspaceId: string, postId: string) {
  const post = await db.socialPost.findFirst({
    where: { id: postId, workspaceId },
    include: { targets: { include: { account: { select: { id: true, username: true, platform: true } } } } },
  })
  if (!post) throw new SocialError(404, 'post_not_found', 'Post not found')
  return post
}

/** Reschedule or edit an unpublished post. Published targets are immutable. */
export async function updatePost(
  workspaceId: string,
  postId: string,
  patch: { content?: unknown; scheduledFor?: unknown; tags?: unknown },
) {
  const post = await getPost(workspaceId, postId)
  if (post.status === 'published' || post.status === 'partial' || post.status === 'publishing') {
    throw new SocialError(409, 'post_immutable', 'A published post cannot be edited')
  }

  const data: Record<string, unknown> = {}
  if (patch.content !== undefined) {
    const content = typeof patch.content === 'string' ? patch.content.trim() : ''
    if (!content && !(Array.isArray(post.mediaJson) && post.mediaJson.length)) {
      throw new SocialError(400, 'empty_post', 'A post needs text or media')
    }
    data.content = content
  }
  if (patch.scheduledFor !== undefined) {
    const scheduledFor = parseScheduledFor(patch.scheduledFor)
    if (scheduledFor && scheduledFor.getTime() <= Date.now()) {
      throw new SocialError(400, 'invalid_schedule', 'scheduledFor must be in the future')
    }
    data.scheduledFor = scheduledFor
    if (scheduledFor) data.status = 'scheduled'
  }
  if (patch.tags !== undefined) data.tags = stringList(patch.tags, 'tags')

  if (Object.keys(data).length === 0) return post

  // Zernio already holds the scheduled time — patching only our row would let it
  // publish at the old one. Update the provider first, then the row.
  if (post.zernioPostId && post.status === 'scheduled') {
    const providerPatch: Record<string, unknown> = {}
    if (data.content !== undefined) providerPatch.content = data.content
    if (data.scheduledFor !== undefined) {
      providerPatch.scheduledFor = data.scheduledFor ? (data.scheduledFor as Date).toISOString() : null
    }
    if (Object.keys(providerPatch).length) {
      const stamp = data.scheduledFor ? (data.scheduledFor as Date).getTime() : 'cleared'
      await getSocialClient().request({
        workspaceId,
        method: 'PATCH',
        path: `/posts/${encodeURIComponent(post.zernioPostId)}`,
        body: providerPatch,
        idempotencyKey: `social-post-update-${post.id}-${stamp}`,
      })
    }
  }

  await db.socialPost.update({ where: { id: post.id }, data })
  return getPost(workspaceId, post.id)
}

/** Delete a local draft/scheduled post. Published posts stay for the record. */
export async function deletePost(workspaceId: string, postId: string): Promise<{ deleted: true }> {
  const post = await getPost(workspaceId, postId)
  if (post.status === 'published' || post.status === 'partial' || post.status === 'publishing') {
    throw new SocialError(409, 'post_immutable', 'A published post cannot be deleted')
  }

  // A scheduled post lives at Zernio too: dropping only our row leaves it
  // queued and it still ships. Cancel there first; keep our row if that fails.
  if (post.zernioPostId) {
    await getSocialClient().request({
      workspaceId,
      method: 'DELETE',
      path: `/posts/${encodeURIComponent(post.zernioPostId)}`,
    })
  }

  await db.socialPost.delete({ where: { id: post.id } })
  return { deleted: true }
}

/** Calendar window: everything scheduled or published between `from` and `to`. */
export async function calendar(workspaceId: string, from: Date, to: Date) {
  if (to.getTime() <= from.getTime()) {
    throw new SocialError(400, 'invalid_range', '`to` must be after `from`')
  }
  const posts = await db.socialPost.findMany({
    where: {
      workspaceId,
      status: { not: 'draft' },
      OR: [
        { scheduledFor: { gte: from, lte: to } },
        { publishedAt: { gte: from, lte: to } },
      ],
    },
    include: { targets: { include: { account: { select: { id: true, username: true, platform: true } } } } },
    orderBy: { scheduledFor: 'asc' },
  })
  return posts
}
