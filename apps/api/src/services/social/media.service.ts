// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Media that a post can reference.
 *
 * Zernio publishes only publicly reachable HTTPS URLs, so a file that lives in a
 * workspace — a Content Studio MP4, a rendered image — has to be uploaded before
 * a post can name it. `POST /media/presign` hands back an `uploadUrl` to PUT the
 * bytes to and a `publicUrl` to reference; the upload sits in temporary storage
 * for seven days and is copied to permanent storage once a post references it.
 *
 * The bytes never come through this API: the caller that holds the file (the
 * agent runtime on the same machine) PUTs them to `uploadUrl` itself.
 */

import { SocialError, getSocialClient } from './client'

/**
 * What Zernio's presign accepts. `application/octet-stream` is not on the list
 * and the provider refuses it with its own 400, so it is refused here first with
 * an error that names the real problem: the caller does not know the file type.
 */
export const PRESIGN_CONTENT_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/avi',
  'video/x-msvideo',
  'video/webm',
  'video/x-m4v',
  'application/pdf',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'application/x-subrip',
  'text/vtt',
] as const

const ALLOWED_TYPES = new Set<string>(PRESIGN_CONTENT_TYPES)
/** Zernio's own ceiling; refused before a byte is uploaded. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024

export interface PresignedUpload {
  uploadUrl: string
  publicUrl: string
  key: string | null
  expiresIn: number | null
}

/** The filename as a name, not a path: a caller cannot steer the destination. */
function safeFilename(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const name = value.split(/[\\/]/).pop()?.trim() ?? ''
  if (!name) {
    throw new SocialError(400, 'invalid_body', 'filename is required')
  }
  if (name.length > 200) {
    throw new SocialError(400, 'invalid_body', 'filename is too long')
  }
  return name
}

function mediaContentType(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) {
    throw new SocialError(400, 'invalid_body', 'contentType is required, e.g. video/mp4')
  }
  if (!ALLOWED_TYPES.has(value)) {
    throw new SocialError(
      400,
      'invalid_content_type',
      `${value} is not a media type Zernio accepts. Send the file's real type — image/jpeg, video/mp4, image/png and so on — not application/octet-stream.`,
    )
  }
  return value
}

function mediaSize(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const size = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(size) || size <= 0) {
    throw new SocialError(400, 'invalid_body', 'size must be a positive number of bytes')
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new SocialError(400, 'media_too_large', 'Zernio accepts files up to 5 GB')
  }
  return Math.floor(size)
}

/**
 * Mint an upload slot. The caller PUTs the bytes to `uploadUrl` with the same
 * `contentType`, then references `publicUrl` in the post.
 */
export async function presignMedia(
  workspaceId: string,
  input: { filename?: unknown; contentType?: unknown; size?: unknown },
): Promise<PresignedUpload> {
  const filename = safeFilename(input.filename)
  const contentType = mediaContentType(input.contentType)
  const size = mediaSize(input.size)

  const payload = await getSocialClient().request<any>({
    workspaceId,
    method: 'POST',
    path: '/media/presign',
    body: { filename, contentType, ...(size !== undefined ? { size } : {}) },
  })

  const uploadUrl =
    (typeof payload?.uploadUrl === 'string' && payload.uploadUrl) ||
    (typeof payload?.upload_url === 'string' && payload.upload_url) ||
    (typeof payload?.data?.uploadUrl === 'string' && payload.data.uploadUrl) ||
    (typeof payload?.url === 'string' && payload.url) ||
    ''
  const publicUrl =
    (typeof payload?.publicUrl === 'string' && payload.publicUrl) ||
    (typeof payload?.public_url === 'string' && payload.public_url) ||
    (typeof payload?.data?.publicUrl === 'string' && payload.data.publicUrl) ||
    ''

  if (!uploadUrl || !publicUrl) {
    throw new SocialError(502, 'presign_url_missing', 'Zernio did not return an upload URL.')
  }

  return {
    uploadUrl,
    publicUrl,
    key: typeof payload?.key === 'string' ? payload.key : null,
    expiresIn: typeof payload?.expiresIn === 'number' ? payload.expiresIn : null,
  }
}
