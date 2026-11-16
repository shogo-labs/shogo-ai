// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instagram's licensed music and original sounds, as Zernio serves them.
 *
 * Meta hosts the catalog on graph.facebook.com, so Zernio can only reach it for
 * an Instagram account connected with **Facebook Login**; an Instagram Login
 * account gets `400 instagram_audio_requires_facebook_login`. That is a fact
 * about the account, not about the request, so it is passed through as its own
 * code with the exact reconnect call in the message — the person has to
 * reconnect, and nothing here can do it for them.
 *
 * A track id is only good for about a day and a half (the preview URL expires),
 * and a post that names a track which is gone at publish time **fails** rather
 * than publishing with different audio. `getInstagramAudio` re-checks one id for
 * exactly that reason.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'

const db = prisma as any

export const INSTAGRAM_AUDIO_TYPES = ['music', 'original_sound'] as const
export type InstagramAudioType = (typeof INSTAGRAM_AUDIO_TYPES)[number]

/**
 * What the result says about eligibility. Zernio reports no per-track licensing
 * flag, so we do not invent one: the catalog is Meta's business-account catalog
 * and that is all we can honestly claim.
 */
export const INSTAGRAM_AUDIO_LICENSING =
  "Meta's catalog for business accounts; eligibility not reported"

export interface InstagramAudioTrack {
  audioId: string
  title: string
  audioType: string
  durationMs: number | null
  /** `displayArtist` for music, `igUsername` for an original sound. */
  artist: string | null
  /** Expires after roughly 1.5 days; refresh with `getInstagramAudio`. */
  downloadUrl: string | null
  /** Anything else Zernio sent (an eligibility flag, if it ever adds one). */
  [key: string]: unknown
}

export interface InstagramAudioResult {
  audio: InstagramAudioTrack[]
  licensing: string
}

function parseAudioType(raw: unknown): InstagramAudioType {
  if (raw === undefined || raw === null || raw === '') return 'music'
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!(INSTAGRAM_AUDIO_TYPES as readonly string[]).includes(value)) {
    throw new SocialError(
      400,
      'invalid_audio_type',
      `audioType must be one of: ${INSTAGRAM_AUDIO_TYPES.join(', ')}`,
    )
  }
  return value as InstagramAudioType
}

/**
 * The account row a caller named, proved to belong to this workspace and to be
 * an Instagram account. Both refusals happen before a provider call.
 */
async function instagramAccount(workspaceId: string, accountId: unknown) {
  const value = typeof accountId === 'string' ? accountId.trim() : ''
  if (!value) throw new SocialError(400, 'invalid_body', 'accountId is required')
  const row = await db.socialAccount.findFirst({
    where: { workspaceId, OR: [{ id: value }, { zernioAccountId: value }] },
  })
  if (!row) {
    throw new SocialError(400, 'unknown_account', 'That account does not belong to this workspace.')
  }
  if (row.platform !== 'instagram') {
    throw new SocialError(400, 'not_instagram', 'Instagram audio is only available for an Instagram account.')
  }
  return row
}

/** The reconnect call, spelled out, so the person is not left guessing. */
const FACEBOOK_LOGIN_HINT =
  'Reconnect this Instagram account with Facebook Login: ' +
  'social_media({ action: "connect", platform: "instagram", login_method: "facebook_login" }). ' +
  'Meta serves the music catalog only to accounts signed in through a Facebook Page.'

/**
 * Zernio's `instagram_audio_requires_facebook_login` is a 400 about the account,
 * not a bad request, so it keeps its own code and gets an actionable message.
 */
function mapAudioError(err: unknown): never {
  if (err instanceof SocialError && err.code === 'instagram_audio_requires_facebook_login') {
    throw new SocialError(400, 'instagram_audio_requires_facebook_login', FACEBOOK_LOGIN_HINT, err.details)
  }
  throw err
}

function normalizeTrack(raw: any): InstagramAudioTrack | null {
  const audioId = typeof raw?.audioId === 'string' ? raw.audioId.trim() : ''
  if (!audioId) return null
  const artist =
    (typeof raw?.displayArtist === 'string' && raw.displayArtist) ||
    (typeof raw?.igUsername === 'string' && raw.igUsername) ||
    null
  const duration = Number(raw?.durationInMs)
  const { audioId: _id, title, audioType, durationInMs, displayArtist, igUsername, downloadUrl, ...rest } =
    raw ?? {}
  return {
    audioId,
    title: typeof title === 'string' ? title : '',
    audioType: typeof audioType === 'string' ? audioType : '',
    durationMs: Number.isFinite(duration) ? duration : null,
    artist,
    downloadUrl: typeof downloadUrl === 'string' ? downloadUrl : null,
    ...rest,
  }
}

/** `{ audio: [...] }`, `{ data: [...] }` or a bare array. */
function trackList(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.audio)) return payload.audio
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.items)) return payload.items
  return []
}

/**
 * Search Meta's catalog for one connected Instagram account. No `q` means
 * trending, which is what Zernio returns for an empty query.
 */
export async function searchInstagramAudio(args: {
  workspaceId: string
  accountId: unknown
  audioType?: unknown
  q?: unknown
}): Promise<InstagramAudioResult> {
  const account = await instagramAccount(args.workspaceId, args.accountId)
  const audioType = parseAudioType(args.audioType)
  const q = typeof args.q === 'string' ? args.q.trim() : ''

  let payload: any
  try {
    payload = await getSocialClient().request<any>({
      workspaceId: args.workspaceId,
      method: 'GET',
      path: `/accounts/${encodeURIComponent(account.zernioAccountId)}/instagram/audio`,
      query: { audioType, ...(q ? { q } : {}) },
    })
  } catch (err) {
    mapAudioError(err)
  }

  const audio = trackList(payload)
    .map(normalizeTrack)
    .filter((track): track is InstagramAudioTrack => !!track)
  return { audio, licensing: INSTAGRAM_AUDIO_LICENSING }
}

/**
 * Re-check one track id and refresh its `downloadUrl`. A track that is gone
 * comes back as an empty list rather than an error, so a caller can tell
 * "expired" from "the account cannot search at all".
 */
export async function getInstagramAudio(args: {
  workspaceId: string
  accountId: unknown
  audioId: unknown
}): Promise<InstagramAudioResult> {
  const account = await instagramAccount(args.workspaceId, args.accountId)
  const audioId = typeof args.audioId === 'string' ? args.audioId.trim() : ''
  if (!audioId) throw new SocialError(400, 'invalid_body', 'audioId is required')

  let payload: any
  try {
    payload = await getSocialClient().request<any>({
      workspaceId: args.workspaceId,
      method: 'GET',
      path: `/accounts/${encodeURIComponent(account.zernioAccountId)}/instagram/audio/${encodeURIComponent(audioId)}`,
    })
  } catch (err) {
    mapAudioError(err)
  }

  // A single-track answer is the track itself, not a list.
  const raw = Array.isArray(payload) || Array.isArray(payload?.audio) || Array.isArray(payload?.data)
    ? trackList(payload)
    : payload
      ? [payload]
      : []
  const audio = raw
    .map(normalizeTrack)
    .filter((track): track is InstagramAudioTrack => !!track)
  return { audio, licensing: INSTAGRAM_AUDIO_LICENSING }
}
