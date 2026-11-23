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

import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { CREATE_POST_TIMEOUT_MS, SocialError, getSocialClient } from './client'
import { inAccountScope } from './accounts.service'
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
  'cancelled',
] as const

/**
 * How long a retry of the same post returns the first one instead of publishing
 * again. Zernio keys its own duplicate protection on the media URLs, and a retry
 * re-uploads them, so this window has to be ours.
 */
export const POST_DEDUPE_WINDOW_MS = 15 * 60_000

/**
 * A `publishing` post has to be older than this before we ask the provider
 * whether it landed — a publish that is still in flight has no answer yet.
 */
const RECONCILE_GRACE_MS = 30_000

/**
 * Platforms where Zernio cannot take a published post down: the person has to
 * remove it in the platform's own app.
 * https://docs.zernio.com/posts/unpublish-post
 */
export const UNPUBLISH_UNSUPPORTED_PLATFORMS = ['instagram', 'tiktok', 'snapchat'] as const

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
}

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
  /**
   * Licensed music / original sound for every Instagram target, as
   * `platformSpecificData.audioConfiguration`. Reels only: a track is attached
   * when the post is created, and a track that is gone at publish time fails the
   * post rather than publishing with different audio.
   */
  audio?: unknown
  /**
   * Publish even though the same content, accounts and media went out in the
   * last 15 minutes. A deliberate repost has to say so.
   */
  allowDuplicate?: boolean
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
 *
 * `audio` is the Instagram Reel track, merged in as `audioConfiguration`. A
 * variant that carries its own `audioConfiguration` wins, and with no `audio`
 * the object is exactly what it was before this parameter existed.
 */
export function platformDataFor(
  platform: string,
  variant: Record<string, unknown> | undefined,
  tiktok: Record<string, unknown> | undefined,
  audio?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = { ...(variant ?? {}) }
  if (platform === 'instagram' && audio && data.audioConfiguration === undefined) {
    data.audioConfiguration = audio
  }
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
 * the minute, so the row a double submit would create collides on the unique
 * key; the 15-minute retry window is `findRecentDuplicate`, because a bucket
 * boundary must not let a retry through.
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

async function loadAccounts(workspaceId: string, accountIds: string[], projectId?: string | null) {
  const rows = await db.socialAccount.findMany({
    where: { workspaceId, id: { in: accountIds } },
  })
  const accounts = rows.filter((account: any) => inAccountScope(account, projectId))
  const found = new Map(accounts.map((account: any) => [account.id, account]))
  const missing = accountIds.filter((id) => !found.has(id))
  if (missing.length) {
    // An id that exists in the workspace but not in this caller's scope is a
    // different failure from a typo: the account is real, it just belongs to
    // another project.
    const elsewhere = rows.some((account: any) => missing.includes(account.id))
    if (elsewhere) {
      throw new SocialError(
        403,
        'account_out_of_scope',
        'That account belongs to another project in this workspace.',
      )
    }
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

/**
 * The Instagram Reel track, validated, in Zernio's `audioConfiguration` shape.
 *
 * `audioId` is a digit string (Meta's catalog ids are numeric), and the two
 * volumes are integers 0–100. Anything else is refused here rather than by the
 * provider after the media has been uploaded.
 */
export function parseAudioConfiguration(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SocialError(400, 'invalid_audio', 'audio must be an object: { audioId, audioVolume?, videoVolume? }')
  }
  const input = raw as Record<string, unknown>
  const audioId = typeof input.audioId === 'string' ? input.audioId.trim() : ''
  if (!/^\d+$/.test(audioId)) {
    throw new SocialError(400, 'invalid_audio', 'audio.audioId must be the numeric id from action "audio".')
  }
  const configuration: Record<string, unknown> = { audioId }
  for (const key of ['audioVolume', 'videoVolume'] as const) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new SocialError(400, 'invalid_audio', `audio.${key} must be an integer from 0 to 100.`)
    }
    configuration[key] = value
  }
  return configuration
}

/**
 * Refuse a track on a target that cannot carry one, before any provider call.
 *
 * Zernio attaches audio to a Reel only: a Story, an image or a carousel is
 * refused when the post is created, which is after the media upload. A target's
 * media is its variant's when it has one, otherwise the post's.
 */
function requireReelForAudio(
  accounts: any[],
  variants: Record<string, any>,
  mediaUrls: string[],
): void {
  const notReels = accounts
    .filter((account) => account.platform === 'instagram')
    .filter((account) => {
      const variantMedia = variants[account.id]?.mediaUrls
      const media = Array.isArray(variantMedia) && variantMedia.length ? variantMedia : mediaUrls
      return media.length !== 1 || mediaTypeFor(media[0]!) !== 'video'
    })
    .map((account) => `instagram @${account.username}`)
  if (notReels.length === 0) return
  throw new SocialError(
    400,
    'audio_needs_reel',
    `Audio can only be attached to a Reel: ${notReels.join(', ')} needs exactly one video and no other media.`,
  )
}

/** Same media, in the same order — a different reel is a different post. */
function sameMedia(left: unknown, right: unknown): boolean {
  const a = Array.isArray(left) ? (left as string[]) : []
  const b = Array.isArray(right) ? (right as string[]) : []
  return a.length === b.length && a.every((url, index) => url === b[index])
}

/**
 * The post this submission would duplicate: same content, same media and the
 * same accounts, published (or publishing) within the last 15 minutes.
 *
 * Only a post that reached the provider counts. A `failed` one never went out,
 * so retrying it is the right thing to do, and a `draft`/`scheduled` one is
 * matched by the idempotency key instead.
 */
async function findRecentDuplicate(
  workspaceId: string,
  input: { content: string; accountIds: string[]; mediaUrls: string[] },
): Promise<any | null> {
  const wanted = [...input.accountIds].sort().join(',')
  if (!wanted) return null
  const recent = await db.socialPost.findMany({
    where: {
      workspaceId,
      createdAt: { gte: new Date(Date.now() - POST_DEDUPE_WINDOW_MS) },
      status: { in: ['publishing', 'queued', 'published'] },
    },
    include: { targets: { select: { accountId: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  for (const candidate of recent ?? []) {
    if (String(candidate.content ?? '').trim() !== input.content) continue
    if (!sameMedia(candidate.mediaJson, input.mediaUrls)) continue
    const accounts = (candidate.targets ?? [])
      .map((target: any) => String(target.accountId))
      .sort()
      .join(',')
    if (accounts !== wanted) continue
    return getPost(workspaceId, candidate.id)
  }
  return null
}

export async function createPost(
  workspaceId: string,
  workspaceName: string,
  input: CreatePostInput,
  projectId?: string | null,
) {
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
  const accounts = accountIds.length ? await loadAccounts(workspaceId, accountIds, projectId) : []
  const audio = parseAudioConfiguration(input.audio)

  // Instagram and TikTok have no text-only post. Refusing here costs nothing;
  // finding out from the provider costs a publish attempt that fails per target
  // and leaves the person with a post full of red rows.
  if (!isDraft) {
    requireMedia(accounts, variants, mediaUrls)
    // A track rides on a Reel only, and Zernio refuses anything else after the
    // media upload — so the shape is checked before the post is even created.
    if (audio) requireReelForAudio(accounts, variants, mediaUrls)
  }

  const status: PostStatus = isDraft ? 'draft' : publishNow ? 'publishing' : 'scheduled'
  const bucketKey = postIdempotencyKey(workspaceId, { content, accountIds, scheduledFor, mediaUrls })
  // A deliberate repost of the same content cannot reuse the bucket key: the
  // column is unique and it would collide with the post it means to repeat.
  const idempotencyKey = input.allowDuplicate ? `${bucketKey}-${randomUUID()}` : bucketKey

  if (!input.allowDuplicate) {
    const existing = await db.socialPost.findUnique({ where: { idempotencyKey } })
    if (existing) return { ...(await getPost(workspaceId, existing.id)), deduped: true }

    // The minute bucket above misses a retry that lands in the next one, which
    // is exactly how the CON-19 duplicates happened: the publish timed out, the
    // retry carried a new key and every account got a second copy.
    const duplicate = await findRecentDuplicate(workspaceId, { content, accountIds, mediaUrls })
    if (duplicate) return { ...duplicate, deduped: true }
  }

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
      audio,
    )
    if (data) platformData.set(account.id, data)
  }

  try {
    await dispatchPost(workspaceId, workspaceName, post.id, { publishNow, platformSpecificData: platformData })
  } catch (err) {
    // A publish that timed out may already be live — Zernio accepted it and we
    // simply stopped waiting. Failing the row and telling the caller to retry is
    // how one reel became two, so the row stays `publishing` with an
    // `unconfirmed` outcome and the next read reconciles it against Zernio.
    if (err instanceof SocialError && (err.code === 'zernio_timeout' || err.status === 504)) {
      return { ...(await getPost(workspaceId, post.id)), outcome: 'unconfirmed' as const }
    }
    await markPostFailed(post.id, err)
    throw err
  }
  return { ...(await getPost(workspaceId, post.id)), outcome: 'confirmed' as const }
}

/**
 * The Zernio account id a provider target names. Zernio answers with an id
 * string on a create and with the populated account object on a list, so both
 * have to read.
 */
function providerAccountId(target: any): string | null {
  const raw = target?.accountId ?? target?.account_id
  if (typeof raw === 'string') return raw || null
  return zernioId(raw)
}

/**
 * Where a provider target's live post can be found: Zernio names it
 * `platformPostUrl` on a list, `publishedUrl`/`platformPostUrl` on a read and
 * `url`/`postUrl` on a create.
 */
function providerPostUrl(target: any): string | null {
  for (const key of ['platformPostUrl', 'publishedUrl', 'url', 'postUrl']) {
    const value = target?.[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/** The platform's own id for the published target, under any of its names. */
function providerPlatformPostId(target: any): string | null {
  for (const key of ['platformPostId', 'postId']) {
    const value = target?.[key]
    if (typeof value === 'string' && value) return value
  }
  return zernioId(target, 'platformPost')
}

/**
 * Why a target failed, as the platform said it. `platformError.message` is the
 * human sentence; `errorCategory` is the machine reason a retry could act on, so
 * it rides along in brackets rather than replacing the sentence.
 */
function providerErrorMessage(remote: any): string | null {
  const platformError = remote?.platformError
  const message =
    (typeof platformError === 'string' && platformError) ||
    (typeof platformError?.message === 'string' && platformError.message) ||
    (typeof remote?.error === 'string' && remote.error) ||
    (typeof remote?.error?.message === 'string' && remote.error.message) ||
    ''
  if (!message) return null
  const category = typeof remote?.errorCategory === 'string' ? remote.errorCategory : ''
  return category ? `[${category}] ${message}` : message
}

/**
 * A provider target's own status, in our per-target vocabulary — or `null` for
 * a status we do not know, which leaves the row as it is. Only a status we
 * understand may move a target: reading `scheduled`/`uploading` as `published`
 * is how a scheduled post would look live the moment we started checking it.
 */
export function targetStatusFrom(remote: any): string | null {
  const status = typeof remote?.status === 'string' ? remote.status.toLowerCase() : ''
  if (status === 'failed' || status === 'error' || providerErrorMessage(remote)) return 'failed'
  if (status === 'published' || status === 'completed' || status === 'posted') return 'published'
  if (status === 'pending' || status === 'scheduled' || status === 'queued') return 'pending'
  if (status === 'publishing' || status === 'uploading' || status === 'processing') return 'publishing'
  if (status === 'cancelled' || status === 'canceled' || status === 'deleted') return 'cancelled'
  return null
}

/**
 * Write a provider target's state onto one of our targets, when it changed.
 * `whenUnknown` is for the create path only: a publish-now create has already
 * handed the post to the provider, so its answer is a receipt — whereas a
 * reconcile read must never treat an unreadable status as published.
 */
function targetPatch(remote: any, target: any, whenUnknown?: string): Record<string, unknown> | null {
  const status = targetStatusFrom(remote) ?? whenUnknown ?? target?.status
  if (!status) return null
  const patch = {
    status,
    platformPostId: providerPlatformPostId(remote) ?? target?.platformPostId ?? null,
    platformPostUrl: providerPostUrl(remote) ?? target?.platformPostUrl ?? null,
    error: status === 'failed' ? (providerErrorMessage(remote) ?? 'Publish failed') : null,
  }
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
    (key) => (target?.[key] ?? null) !== patch[key],
  )
  return changed ? patch : null
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
    // The create carries the media and waits for the platform to accept it, so
    // it gets the publish budget rather than the 15 s read default.
    timeoutMs: CREATE_POST_TIMEOUT_MS,
  })

  const providerTargets: any[] = Array.isArray(result?.targets)
    ? result.targets
    : Array.isArray(result?.platforms)
      ? result.platforms
      : []
  const byProviderAccount = new Map(
    providerTargets
      .map((t: any) => [providerAccountId(t), t] as const)
      .filter(([id]) => !!id),
  )

  for (const target of post.targets) {
    const remote = byProviderAccount.get(target.account.zernioAccountId)
    if (!remote) continue
    // A status we cannot read leaves the row where it is — except that a
    // publish-now create's answer is a receipt: it accepted the post, so an
    // unknown state there is `published`, as it always was.
    const patch = targetPatch(remote, target, publishNow ? 'published' : undefined)
    if (patch) await db.socialPostTarget.update({ where: { id: target.id }, data: patch })
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

/** The post object inside a provider read, which arrives wrapped or bare. */
function postDetailFrom(answer: any): any {
  const wrapped = answer?.post ?? answer?.data?.post
  if (wrapped && typeof wrapped === 'object') return wrapped
  return answer && typeof answer === 'object' ? answer : null
}

function parseProviderDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value !== 'string' || !value) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

/** The post status our per-target rows add up to; a post with nothing out yet is publishing. */
function postStatusFromCounts(targets: Array<{ status: string }>): PostStatus {
  const published = targets.filter((row) => row.status === 'published').length
  const failed = targets.filter((row) => row.status === 'failed').length
  if (published === 0 && failed > 0) return 'failed'
  if (failed > 0) return 'partial'
  if (published > 0) return 'published'
  return 'publishing'
}

/** Rows that have not gone out yet, so no provider read may call them `publishing`. */
const NOT_YET_OUT = new Set(['draft', 'scheduled'])

/** A provider answer's targets, which Zernio names `platforms` on a read and `targets` on a create. */
function providerTargetsOf(remote: any): any[] {
  if (Array.isArray(remote?.platforms)) return remote.platforms
  if (Array.isArray(remote?.targets)) return remote.targets
  return []
}

/**
 * The one writer for a provider post's state, shared by the read path and the
 * webhook so a post cannot end up described two different ways.
 *
 * Targets are matched by provider account. A provider answer that omits a
 * target leaves it alone, a status we do not understand leaves it alone, and
 * re-applying the same state writes nothing — a redelivered webhook is a no-op.
 */
export async function applyProviderPostState(post: any, remote: any) {
  const platforms = providerTargetsOf(remote)
  const byAccount = new Map(
    platforms.map((entry: any) => [providerAccountId(entry), entry] as const).filter(([id]) => !!id),
  )
  for (const target of post.targets ?? []) {
    const providerTarget = byAccount.get(target.account?.zernioAccountId)
    if (!providerTarget) continue
    const patch = targetPatch(providerTarget, target)
    if (patch) await db.socialPostTarget.update({ where: { id: target.id }, data: patch })
  }

  const targets = await db.socialPostTarget.findMany({
    where: { postId: post.id },
    select: { status: true },
  })
  const derived = postStatusFromCounts(targets)
  // `publishing` is what the counts say when nothing has gone out yet, which is
  // true of a scheduled post the provider has not started. Calling that
  // `publishing` would claim a post is on its way out when it is still waiting,
  // so a row that had not gone out stays where it was unless a leg is in flight.
  const status =
    derived === 'publishing' &&
    NOT_YET_OUT.has(post.status) &&
    !targets.some((row: any) => row.status === 'publishing')
      ? post.status
      : derived
  // The provider's own `publishedAt` is the truth; without one, the moment we
  // first saw the post go out is. An existing value is never overwritten, so a
  // second read cannot walk the date forward.
  const finished = status === 'published' || status === 'partial'
  const publishedAt = post.publishedAt ?? (finished ? (parseProviderDate(remote?.publishedAt) ?? new Date()) : null)
  const zernioPostId = post.zernioPostId ?? zernioId(remote, 'post')

  const unchanged =
    post.status === status &&
    (post.zernioPostId ?? null) === zernioPostId &&
    (post.publishedAt ? new Date(post.publishedAt).getTime() : null) ===
      (publishedAt ? publishedAt.getTime() : null)
  if (!unchanged) {
    await db.socialPost.update({ where: { id: post.id }, data: { status, zernioPostId, publishedAt } })
    post.status = status
    post.zernioPostId = zernioPostId
    post.publishedAt = publishedAt
  }
  return post
}

const missingPostLogged = new Set<string>()

/** Room to explain a 404 once per post instead of on every read of a list. */
function noteMissingProviderPost(post: any) {
  const id = String(post.zernioPostId ?? post.id ?? '')
  if (!id || missingPostLogged.has(id)) return
  missingPostLogged.add(id)
  console.warn('[Social] the provider has no post for a row we scheduled; leaving it as it is', {
    postId: post.id,
    zernioPostId: post.zernioPostId,
  })
}

/**
 * Has this row waited long enough for the provider to have an answer, and is it
 * in a state where the answer could still change it?
 */
function dueForProviderCheck(post: any): boolean {
  const now = Date.now()
  if (post.status === 'scheduled') {
    const due = post.scheduledFor ? new Date(post.scheduledFor).getTime() : NaN
    return Number.isFinite(due) && due <= now - RECONCILE_GRACE_MS
  }
  if (post.status === 'publishing') return true
  // A post can read finished while one leg is still in flight — a TikTok upload
  // holds for up to 48 h — so a target that has not settled keeps it live for
  // another check rather than freezing it on `publishing`.
  return (post.targets ?? []).some((target: any) => target.status === 'publishing')
}

const RECONCILED_INCLUDE = {
  targets: { include: { account: { select: { id: true, username: true, platform: true, zernioAccountId: true } } } },
}

/** Re-read rather than return the bare row: every caller of `getPost` reads `post.targets`. */
async function rereadPost(workspaceId: string, post: any) {
  const reconciled = await db.socialPost.findFirst({
    where: { id: post.id, workspaceId },
    include: RECONCILED_INCLUDE,
  })
  return reconciled ?? post
}

/** Read one post we already handed to Zernio, by the id it gave us. */
async function reconcileKnownPost(workspaceId: string, post: any, opts: { force?: boolean } = {}) {
  if (!opts.force && !dueForProviderCheck(post)) return post
  let detail: any
  try {
    const answer = await getSocialClient().request<any>({
      workspaceId,
      method: 'GET',
      path: `/posts/${encodeURIComponent(post.zernioPostId)}`,
    })
    detail = postDetailFrom(answer)
  } catch (err) {
    // An unreachable provider is not evidence of anything, and a 404 for a post
    // we scheduled is not proof it went out — Zernio may simply not have it yet.
    // Either way the row stays as it is and the next read asks again.
    if (err instanceof SocialError && err.status === 404) noteMissingProviderPost(post)
    return post
  }
  if (!detail) return post
  // An answer that names no target tells us nothing about this post's legs, and
  // applying it would derive a status from targets it never mentioned.
  if (providerTargetsOf(detail).length === 0) return post
  await applyProviderPostState(post, detail)
  return rereadPost(workspaceId, post)
}

/**
 * Ask the provider what happened to a post we already handed it.
 *
 * Two kinds of row go stale. A publish that timed out is left at `publishing`
 * with no provider id, and Zernio may well have accepted it — rather than
 * publish again, the next read finds it at Zernio by its content and accounts.
 * A scheduled post keeps `scheduled` for ever because nothing ever wrote the
 * provider's eventual answer back, so once it is due the same read fetches it by
 * `zernioPostId`. Both end in `applyProviderPostState`, the one writer.
 *
 * `force` is for an explicit delete, which is worth one read even for a row that
 * is not due yet: a post can go out early, and delete is the one call where
 * believing a stale `scheduled` asks the provider to delete a live post.
 */
export async function reconcilePost(workspaceId: string, post: any, opts: { force?: boolean } = {}) {
  if (!post) return post
  if (post.zernioPostId) return reconcileKnownPost(workspaceId, post, opts)
  if (post.status !== 'publishing') return post
  const createdAt = post.createdAt instanceof Date ? post.createdAt : new Date(post.createdAt)
  if (!Number.isFinite(createdAt.getTime())) return post
  if (Date.now() - createdAt.getTime() < RECONCILE_GRACE_MS) return post

  const wanted = (post.targets ?? [])
    .map((target: any) => target.account?.zernioAccountId)
    .filter((id: unknown): id is string => typeof id === 'string' && !!id)
    .sort()
    .join(',')
  if (!wanted) return post

  let listed: any
  try {
    listed = await getSocialClient().request<any>({
      workspaceId,
      method: 'GET',
      path: '/posts',
      query: { limit: 50, sortBy: 'created-desc', fromDate: createdAt.toISOString() },
    })
  } catch {
    // The row stays `publishing` and the next read tries again: a provider we
    // cannot reach is not evidence that nothing was published.
    return post
  }

  const candidates: any[] = Array.isArray(listed?.posts)
    ? listed.posts
    : Array.isArray(listed)
      ? listed
      : []
  const content = String(post.content ?? '').trim()
  const match = candidates.find((candidate: any) => {
    if (String(candidate?.content ?? '').trim() !== content) return false
    const platforms: any[] = Array.isArray(candidate?.platforms) ? candidate.platforms : []
    const accounts = platforms
      .map(providerAccountId)
      .filter((id): id is string => !!id)
      .sort()
      .join(',')
    return accounts === wanted
  })
  if (!match) return post

  const platforms: any[] = Array.isArray(match.platforms) ? match.platforms : []
  if (platforms.length === 0) return post

  await applyProviderPostState(post, match)
  return rereadPost(workspaceId, post)
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
  const posts = await db.socialPost.findMany({
    where,
    include: RECONCILED_INCLUDE,
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  })
  const reconciled = await reconcileList(workspaceId, posts)
  if (!opts.status) return reconciled
  // The filter was applied to the stale row. A post that reconciled to another
  // status is no longer in the set the caller asked for — it shows up under the
  // status the same read now gives it.
  return reconciled.filter((post: any) => post.status === opts.status)
}

/** Will reading this row ask the provider anything? */
function willAskProvider(post: any): boolean {
  if (post.zernioPostId) return dueForProviderCheck(post)
  return post.status === 'publishing'
}

/**
 * Reconcile the stale rows of a page, bounded: 200 rows of history must not
 * become 200 provider calls. Oldest first in the page, so a backlog drains over
 * the next few reads rather than never.
 */
async function reconcileList(workspaceId: string, posts: any[], limit = 25): Promise<any[]> {
  let asked = 0
  return Promise.all(
    (posts ?? []).map((post: any) => {
      if (asked >= limit || !willAskProvider(post)) return post
      asked++
      return reconcilePost(workspaceId, post).catch(() => post)
    }),
  )
}

/**
 * Reconcile the workspace's due posts before a count that reads their status.
 *
 * Bounded on purpose: a report may not turn into a hundred provider calls. The
 * oldest rows go first, so a backlog drains over a few reads rather than never.
 */
export async function reconcileDuePosts(workspaceId: string, limit = 25) {
  const dueBefore = new Date(Date.now() - RECONCILE_GRACE_MS)
  const [scheduled, publishing] = await Promise.all([
    db.socialPost.findMany({
      where: { workspaceId, status: 'scheduled', zernioPostId: { not: null }, scheduledFor: { lte: dueBefore } },
      include: RECONCILED_INCLUDE,
      orderBy: { scheduledFor: 'asc' },
      take: limit,
    }),
    db.socialPost.findMany({
      where: { workspaceId, status: 'publishing', zernioPostId: { not: null } },
      include: RECONCILED_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),
  ])
  const due = [...(scheduled ?? []), ...(publishing ?? [])]
  await reconcileList(workspaceId, due, limit)
  return Math.min(due.length, limit)
}

export async function getPost(workspaceId: string, postId: string) {
  const post = await db.socialPost.findFirst({
    where: { id: postId, workspaceId },
    include: { targets: { include: { account: { select: { id: true, username: true, platform: true, zernioAccountId: true } } } } },
  })
  if (!post) throw new SocialError(404, 'post_not_found', 'Post not found')
  return reconcilePost(workspaceId, post).catch(() => post)
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

/** One target the delete touched, as the UI and the agent both report it. */
export interface DeletePostRemoval {
  platform: string
  account: string | null
  url: string | null
}

export interface DeletePostResult {
  /** True when the row is gone: nothing was live at the provider. */
  deleted: boolean
  /** True when the row is kept, because it holds the record of a live post. */
  kept?: boolean
  post?: unknown
  removed: DeletePostRemoval[]
  /** Targets the person has to take down themselves, and why. */
  manual: Array<DeletePostRemoval & { reason: string }>
}

/** Rows that hold, or may hold, a post that is out — so delete takes it down rather than dropping the record. */
function isLiveStatus(status: string): boolean {
  return status === 'published' || status === 'partial' || status === 'publishing'
}

/**
 * "Published posts cannot be deleted" — Zernio's refusal to cancel a post that
 * has already gone out, sent as a 400 `invalid_request_error` that names the
 * unpublish routes the platform does not have. The sentence is the reliable
 * part: a 400 alone could be anything.
 */
function isPublishedRefusal(err: unknown): boolean {
  return err instanceof SocialError && /published posts cannot be deleted/i.test(err.message)
}

/** The row as delete needs it — the full account, because unpublish needs its provider id. */
async function loadPostForDelete(workspaceId: string, postId: string) {
  return db.socialPost.findFirst({
    where: { id: postId, workspaceId },
    include: { targets: { include: { account: true } } },
  })
}

/**
 * Take a live post down, per target: unpublish where the provider can, and hand
 * the rest to the person with their links. Instagram, TikTok and Snapchat have
 * no removal API, so those targets come back under `manual` and the row is kept
 * (`cancelled` once nothing is left live) so the history and the analytics stay
 * honest.
 *
 * `assumeLive` is for the delete the provider refused because the post is out:
 * that refusal is proof it went out, so a target still reading `pending` is
 * treated as live for this call rather than left looking queued — but it is not
 * written as published, because which legs went out is the provider's answer to
 * give, and the next read asks for it.
 */
async function takeDownLive(
  workspaceId: string,
  post: any,
  opts: { assumeLive?: boolean } = {},
): Promise<DeletePostResult> {
  const liveTarget = (target: any) =>
    target.status === 'published' || (opts.assumeLive === true && target.status === 'pending')
  const removed: DeletePostRemoval[] = []
  const manual: Array<DeletePostRemoval & { reason: string }> = []
  const removedIds = new Set<string>()

  for (const target of post.targets) {
    const entry: DeletePostRemoval = {
      platform: target.platform,
      account: target.account?.username ?? null,
      url: target.platformPostUrl ?? null,
    }
    if (target.status === 'publishing') {
      manual.push({ ...entry, reason: 'Still being published — check again in a minute, then delete again.' })
      continue
    }
    if (!liveTarget(target)) continue

    const label = PLATFORM_LABELS[target.platform] ?? target.platform
    if ((UNPUBLISH_UNSUPPORTED_PLATFORMS as readonly string[]).includes(target.platform)) {
      manual.push({
        ...entry,
        reason: `${label} has no API to remove a published post — remove it in the ${label} app.`,
      })
      continue
    }
    // A row reconciled from a relayed publish can be live without the provider id
    // we would unpublish against; `/posts/null/unpublish` is not a call worth
    // making, so those targets go to the person too.
    if (!post.zernioPostId) {
      manual.push({
        ...entry,
        reason: `No provider post id was recorded for this one — remove it in the ${label} app.`,
      })
      continue
    }

    try {
      await getSocialClient().request({
        workspaceId,
        method: 'POST',
        path: `/posts/${encodeURIComponent(post.zernioPostId)}/unpublish`,
        body: {
          // Zernio calls X `twitter` in its own platform list.
          platform: target.platform === 'x' ? 'twitter' : target.platform,
          ...(target.account?.zernioAccountId ? { accountId: target.account.zernioAccountId } : {}),
        },
      })
    } catch (err) {
      // The provider's own sentence for "it is out and cannot be taken down" is
      // the one thing this path must not repeat back: the person needs to know
      // what to do, not what Zernio called it.
      manual.push({
        ...entry,
        reason: isPublishedRefusal(err)
          ? `The provider would not take this ${label} post down — remove it in the ${label} app.`
          : `The provider could not remove it: ${detailOf(err).message}`,
      })
      continue
    }
    await db.socialPostTarget.update({ where: { id: target.id }, data: { status: 'cancelled' } })
    removedIds.add(target.id)
    removed.push(entry)
  }

  const stillLive = post.targets.filter(
    (target: any) =>
      !removedIds.has(target.id) && (liveTarget(target) || target.status === 'publishing'),
  ).length
  if (stillLive === 0) {
    await db.socialPost.update({ where: { id: post.id }, data: { status: 'cancelled' } })
  }

  const updated = await db.socialPost.findFirst({
    where: { id: post.id, workspaceId },
    include: { targets: { include: { account: { select: { id: true, username: true, platform: true, zernioAccountId: true } } } } },
  })
  return { deleted: false, kept: true, post: updated, removed, manual }
}

/**
 * Delete a post, at the provider and here.
 *
 * A draft, a scheduled post, a failed one or a cancelled one is removed
 * outright — Zernio is told first so a scheduled post cannot still ship. A post
 * that went out is a different thing: it is taken down per target by
 * `takeDownLive`.
 *
 * Which of the two it is has to come from the provider, not from the row's own
 * `status`: a row that went out but was never reconciled still reads `scheduled`
 * here, and deleting it would ask Zernio to cancel a post that is already live.
 */
export async function deletePost(workspaceId: string, postId: string): Promise<DeletePostResult> {
  const loaded = await loadPostForDelete(workspaceId, postId)
  if (!loaded) throw new SocialError(404, 'post_not_found', 'Post not found')

  // A publish that timed out is still in flight and carries no provider id, so
  // there is nothing to cancel or unpublish. Deleting the row would hide a post
  // that may be about to go live — the caller has to look again instead.
  if (loaded.status === 'publishing' && !loaded.zernioPostId) {
    throw new SocialError(
      409,
      'post_in_flight',
      'This post is still publishing and has no provider id yet. Check "posts" again in a minute, then delete it.',
    )
  }

  // Ask the provider before the row's status decides anything. A live row needs
  // no read — the take-down path is the same either way — but a row that reads
  // "not live" with an id to cancel is exactly the stale case, and an explicit
  // delete is worth one read even when it is not due yet.
  const suspect = !isLiveStatus(loaded.status) && !!loaded.zernioPostId
  let post = await reconcilePost(workspaceId, loaded, { force: suspect }).catch(() => loaded)

  if (isLiveStatus(post.status)) return takeDownLive(workspaceId, post)

  if (post.zernioPostId) {
    try {
      // A scheduled post lives at Zernio too: dropping only our row leaves it
      // queued and it still ships. Cancel there first; keep our row if that fails.
      await getSocialClient().request({
        workspaceId,
        method: 'DELETE',
        path: `/posts/${encodeURIComponent(post.zernioPostId)}`,
      })
    } catch (err) {
      // Zernio refuses to delete a post that is already out. That is the answer
      // the read above could not get, so take it as proof it is live and hand
      // the person the links instead of repeating the refusal back at them.
      if (!isPublishedRefusal(err)) throw err
      const again = await reconcilePost(workspaceId, post, { force: true }).catch(() => post)
      return takeDownLive(workspaceId, again, { assumeLive: !isLiveStatus(again.status) })
    }
  }
  await db.socialPost.delete({ where: { id: post.id } })
  return { deleted: true, removed: [], manual: [] }
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
    include: { targets: { include: { account: { select: { id: true, username: true, platform: true, zernioAccountId: true } } } } },
    orderBy: { scheduledFor: 'asc' },
  })
  // The calendar draws a status per post, so it has to be the same status the
  // list and the detail view show — reconciled, not read straight off the row.
  return reconcileList(workspaceId, posts)
}
