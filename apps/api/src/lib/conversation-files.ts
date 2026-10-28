// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage for files shared in workspace channels. Cloud stores objects in the
 * artifact bucket; desktop/local mode writes under the Shogo data directory.
 *
 * Read URLs are capability URLs (HMAC of the attachment id and an expiry)
 * because image and video elements and native image loaders cannot attach
 * session credentials. Expiry is rounded to a day so a message's URLs stay
 * stable (and cacheable) while clients hold it; members can always re-fetch
 * the message for a fresh link.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { mkdirSync } from 'fs'
import { readFile, writeFile, rm } from 'fs/promises'
import { dirname, join, normalize } from 'path'
import { homedir } from 'os'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getArtifactBucket, getArtifactPresignedReadUrl, getArtifactS3Client } from './s3'

export const MAX_CONVERSATION_FILE_BYTES = 50 * 1024 * 1024
export const CONVERSATION_FILE_PREFIX = 'artifacts/conversations/'

const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

function signingSecret(): string {
  const secret = process.env.AI_PROXY_SECRET || process.env.BETTER_AUTH_SECRET || process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('[ConversationFiles] No signing secret configured')
  return 'shogo-dev-only-conversation-file-secret'
}

export function signConversationFileToken(attachmentId: string): string {
  return createHmac('sha256', signingSecret()).update(`conversation-file:${attachmentId}`).digest('hex')
}

export function verifyConversationFileToken(attachmentId: string, token: string | undefined | null): boolean {
  if (!token) return false
  const expected = Buffer.from(signConversationFileToken(attachmentId))
  const actual = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const FILE_LINK_BUCKET_MS = 24 * 60 * 60 * 1000

/** Valid for 24 to 48 hours. */
export function signAttachmentToken(attachmentId: string, nowMs = Date.now()): string {
  const exp = (Math.floor(nowMs / FILE_LINK_BUCKET_MS) + 2) * FILE_LINK_BUCKET_MS
  const mac = createHmac('sha256', signingSecret()).update(`conversation-file:${attachmentId}:${exp}`).digest('hex')
  return `${exp.toString(36)}.${mac}`
}

export function verifyAttachmentToken(attachmentId: string, token: string | undefined | null, nowMs = Date.now()): boolean {
  const [expPart, mac] = (token ?? '').split('.')
  if (!expPart || !mac) return false
  const exp = parseInt(expPart, 36)
  if (!Number.isFinite(exp) || exp <= nowMs) return false
  const expected = Buffer.from(createHmac('sha256', signingSecret()).update(`conversation-file:${attachmentId}:${exp}`).digest('hex'))
  const actual = Buffer.from(mac)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function conversationFileUrl(attachment: { id: string }): string {
  return `/api/conversation-files/${attachment.id}?t=${signAttachmentToken(attachment.id)}`
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[/\\?%*:|"<>\u0000-\u001f]+/g, '_').trim().slice(-120)
  return cleaned || 'file'
}

export function buildConversationFileKey(workspaceId: string, conversationId: string, name: string): string {
  return `${CONVERSATION_FILE_PREFIX}${workspaceId}/${conversationId}/${crypto.randomUUID()}-${sanitizeName(name)}`
}

const MAX_ATTACHMENT_DURATION_MS = 60 * 60 * 1000
const MAX_WAVEFORM_PEAKS = 256

/**
 * Length of a voice note. Clamped rather than rejected: a client that
 * mis-measures its own clip should still be able to send it.
 */
export function parseAttachmentDurationMs(value: unknown): number | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(Math.round(ms), MAX_ATTACHMENT_DURATION_MS)
}

/**
 * Waveform levels for a voice note, as `0-100` values. Stored space separated.
 * Returns null for anything unparseable so the player falls back to a
 * synthesized waveform rather than drawing nonsense.
 */
export function parseAttachmentPeaks(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const tokens = raw.split(/[,\s]+/).filter(Boolean).slice(0, MAX_WAVEFORM_PEAKS)
  if (!tokens.length) return null
  const levels: number[] = []
  for (const token of tokens) {
    const level = Number(token)
    if (!Number.isFinite(level)) return null
    levels.push(Math.max(0, Math.min(100, Math.round(level))))
  }
  return levels.join(' ')
}

export type ParsedByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'none' }
/**
 * A single `bytes=` range, resolved against the file size.
 *
 * Audio and video elements *need* this: iOS AVPlayer and Safari issue a range
 * request before they will play a remote clip at all, and every player seeks
 * with one. An unsupported or malformed range is reported as `none` so the
 * caller serves the whole file, which is what RFC 9110 asks for; only a
 * syntactically valid range that starts past the end is `unsatisfiable`.
 */
export function parseByteRange(header: string | undefined | null, size: number): ParsedByteRange {
  if (!header) return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: 'none' }
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return { kind: 'none' }
  if (size <= 0) return { kind: 'unsatisfiable' }

  if (!rawStart) {
    // `bytes=-N`: the final N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'none' }
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' }
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return { kind: 'none' }
  return { kind: 'range', start, end }
}

function localRoot(): string {
  return join(process.env.SHOGO_DATA_DIR || join(homedir(), '.shogo'), 'conversation-files')
}

function localPath(key: string): string {
  const root = localRoot()
  const full = normalize(join(root, key))
  if (!full.startsWith(root)) throw new Error('Invalid storage key')
  return full
}

export async function putConversationFile(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  if (isLocalMode()) {
    const path = localPath(key)
    mkdirSync(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return
  }
  await getArtifactS3Client().send(new PutObjectCommand({
    Bucket: getArtifactBucket(),
    Key: key,
    Body: bytes,
    ContentType: mimeType,
  }))
}

export type ConversationFileRead =
  | { kind: 'redirect'; url: string }
  | { kind: 'bytes'; bytes: Uint8Array }

/**
 * Read a stored file. `downloadName` asks for it to be saved rather than
 * displayed: local storage can be told with a header on the way out, but cloud
 * storage serves the bytes itself, so there the disposition has to be part of
 * the signed URL instead.
 */
export async function readConversationFile(
  key: string,
  options: { downloadName?: string | null } = {},
): Promise<ConversationFileRead> {
  if (isLocalMode()) return { kind: 'bytes', bytes: await readFile(localPath(key)) }
  const responseContentDisposition = options.downloadName
    ? `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`
    : undefined
  return {
    kind: 'redirect',
    url: await getArtifactPresignedReadUrl(key, { expiresIn: 300, responseContentDisposition }),
  }
}

export interface ConversationFileStream {
  /** The object's bytes, still on the wire. Never buffered. */
  body: ReadableStream<Uint8Array>
  contentLength: number | null
  contentType: string | null
}

/**
 * Cloud read for a caller that has to receive the bytes itself.
 *
 * A script `fetch` cannot follow the presigned redirect: the bucket answers
 * `Access-Control-Allow-Origin: *`, which a browser refuses for a credentialed
 * cross-origin request, so the object is streamed through the API instead.
 * Cloud only — in local mode `readConversationFile` hands the route the bytes
 * and this is never reached.
 */
export async function readConversationFileStream(
  key: string,
  options: { range?: { start: number; end: number } | null } = {},
): Promise<ConversationFileStream> {
  const response = await getArtifactS3Client().send(new GetObjectCommand({
    Bucket: getArtifactBucket(),
    Key: key,
    ...(options.range ? { Range: `bytes=${options.range.start}-${options.range.end}` } : {}),
  }))
  const body = response.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined
  if (typeof body?.transformToWebStream !== 'function') {
    throw new Error('Object storage returned no readable body')
  }
  return {
    body: body.transformToWebStream(),
    contentLength: typeof response.ContentLength === 'number' ? response.ContentLength : null,
    contentType: response.ContentType ?? null,
  }
}

/**
 * True when the request is a script read (`fetch`/XHR) that will consume the
 * bytes itself, rather than something that can follow a redirect on its own.
 *
 * Only those break on the cross-origin 302 to object storage. An `<img>`,
 * `<video>`, iframe or link click sends `navigate`/`no-cors`, and a native
 * client or server-to-server call sends no `Sec-Fetch-Mode` at all — all of
 * them keep the cheap redirect.
 */
export function wantsInlineBytes(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const mode = (c.req.header('sec-fetch-mode') ?? '').trim().toLowerCase()
  return mode === 'cors' || mode === 'same-origin'
}

/** The file's bytes, following the presigned redirect in cloud mode. */
export async function loadConversationFileBytes(key: string): Promise<Uint8Array> {
  const file = await readConversationFile(key)
  if (file.kind === 'bytes') return file.bytes
  const res = await fetch(file.url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Could not read the file (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function deleteConversationFile(key: string): Promise<void> {
  if (isLocalMode()) {
    await rm(localPath(key), { force: true })
    return
  }
  await getArtifactS3Client().send(new DeleteObjectCommand({ Bucket: getArtifactBucket(), Key: key }))
}

/** `0:12`, and `1:02:03` only for a clip that actually runs that long. */
export function formatClipDurationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * The second line a conversation list shows for a message that carries no
 * text. A voice note would otherwise preview as blank.
 */
export function previewForAttachments(
  attachments: Array<{ mimeType?: string | null; name?: string | null; durationMs?: number | null }> | null | undefined,
): string {
  const voice = (attachments ?? []).find((a) => String(a?.mimeType ?? '').startsWith('audio/'))
  if (!voice) return ''
  return voice.durationMs ? `🎤 Voice note · ${formatClipDurationLabel(voice.durationMs)}` : '🎤 Voice note'
}
