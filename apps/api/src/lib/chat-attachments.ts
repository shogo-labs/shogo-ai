// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Chat attachment storage.
 *
 * Chat messages arrive with data URLs because the runtime needs the bytes for
 * the current model turn. The persisted copy is rewritten to an object-store
 * reference so large files do not live in PostgreSQL.
 */

import { createHmac, createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getArtifactBucket, getArtifactPresignedReadUrl, getArtifactS3Client } from './s3'
import { safeTokenEqual } from './crypto-util'

export const CHAT_ATTACHMENT_PREFIX = 'artifacts/chat-attachments/'
export const CHAT_ATTACHMENT_URL_PREFIX = '/api/chat-attachments/'

export interface ChatAttachmentPart {
  type: 'file'
  mediaType?: string
  url: string
  name?: string
  attachmentKey?: string
  [key: string]: unknown
}

export interface ExternalizeMessageResult {
  parts: string | null | undefined
  imageData: string | null | undefined
  changed: boolean
  uploaded: number
  bytes: number
  failed: number
}

interface ExternalizeOptions {
  dryRun?: boolean
}

function signingSecret(): string {
  const secret =
    process.env.AI_PROXY_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[ChatAttachments] No signing secret configured')
  }
  return 'shogo-dev-only-chat-attachment-secret'
}

function mediaTypeFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(dataUrl)
  return match?.[1] || null
}

function decodeDataUrl(dataUrl: string): { mediaType: string; bytes: Buffer } | null {
  if (!dataUrl.startsWith('data:')) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const metadata = dataUrl.slice(5, comma)
  if (!/;base64(?:;|$)/i.test(metadata)) return null
  const mediaType = metadata.split(';')[0] || 'application/octet-stream'
  try {
    return { mediaType, bytes: Buffer.from(dataUrl.slice(comma + 1), 'base64') }
  } catch {
    return null
  }
}

function extensionFor(mediaType: string, name?: string): string {
  const nameExtension = name?.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLowerCase()
  if (nameExtension) return nameExtension
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'text/plain': 'txt',
  }
  return known[mediaType.toLowerCase()] || 'bin'
}

export function buildChatAttachmentKey(
  sessionId: string,
  bytes: Uint8Array,
  mediaType: string,
  name?: string,
): string {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return `${CHAT_ATTACHMENT_PREFIX}${sessionId}/${digest}.${extensionFor(mediaType, name)}`
}

export function buildChatAttachmentUrl(key: string): string {
  return `${CHAT_ATTACHMENT_URL_PREFIX}${key}?t=${signAttachmentToken(key)}`
}

export function signAttachmentToken(key: string): string {
  return createHmac('sha256', signingSecret())
    .update(`chat-attachment:${key}`)
    .digest('hex')
}

export function verifyAttachmentToken(
  key: string | undefined | null,
  token: string | undefined | null,
): boolean {
  if (!key || !token || !key.startsWith(CHAT_ATTACHMENT_PREFIX)) return false
  return safeTokenEqual(token, signAttachmentToken(key))
}

export function attachmentKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, 'http://chat-attachments.invalid')
    const pathname = parsed.pathname
    if (!pathname.startsWith(CHAT_ATTACHMENT_URL_PREFIX)) return null
    const key = decodeURIComponent(pathname.slice(CHAT_ATTACHMENT_URL_PREFIX.length))
    return key.startsWith(CHAT_ATTACHMENT_PREFIX) ? key : null
  } catch {
    return null
  }
}

async function uploadAttachment(
  sessionId: string,
  dataUrl: string,
  mediaType: string | undefined,
  name: string | undefined,
  dryRun: boolean,
): Promise<{ key: string; bytes: number; mediaType: string } | null> {
  const decoded = decodeDataUrl(dataUrl)
  if (!decoded) return null
  const effectiveMediaType = mediaType || decoded.mediaType || mediaTypeFromDataUrl(dataUrl) || 'application/octet-stream'
  const key = buildChatAttachmentKey(sessionId, decoded.bytes, effectiveMediaType, name)
  if (!dryRun) {
    const s3 = getArtifactS3Client()
    await s3.send(new PutObjectCommand({
      Bucket: getArtifactBucket(),
      Key: key,
      Body: decoded.bytes,
      ContentType: effectiveMediaType,
    }))
  }
  return { key, bytes: decoded.bytes.byteLength, mediaType: effectiveMediaType }
}

function parseParts(parts: unknown): unknown[] | null {
  if (Array.isArray(parts)) return parts
  if (typeof parts !== 'string' || !parts.trim()) return null
  try {
    const parsed = JSON.parse(parts)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Externalize all data-URL file parts in a message. `imageData` is also
 * handled because legacy clients wrote the first attachment there separately.
 * Upload errors are isolated per attachment; the original data URL remains in
 * the row so a storage outage never loses the user's message.
 */
export async function externalizeMessageAttachments(
  sessionId: string,
  partsInput: unknown,
  imageDataInput: unknown,
  options: ExternalizeOptions = {},
): Promise<ExternalizeMessageResult> {
  const originalParts = parseParts(partsInput)
  const parts = originalParts ? [...originalParts] : []
  const originalImageData = typeof imageDataInput === 'string' ? imageDataInput : imageDataInput
  let imageData = imageDataInput as string | null | undefined
  let changed = false
  let uploaded = 0
  let bytes = 0
  let failed = 0
  const externalizedByDataUrl = new Map<string, { key: string; bytes: number; mediaType: string }>()

  for (const candidate of parts) {
    if (!candidate || typeof candidate !== 'object') continue
    const part = candidate as ChatAttachmentPart
    if (part.type !== 'file' || typeof part.url !== 'string' || !part.url.startsWith('data:')) continue
    try {
      const result = await uploadAttachment(
        sessionId,
        part.url,
        part.mediaType,
        part.name,
        !!options.dryRun,
      )
      if (!result) {
        failed++
        continue
      }
      externalizedByDataUrl.set(part.url, result)
      part.attachmentKey = result.key
      part.url = buildChatAttachmentUrl(result.key)
      part.mediaType ||= result.mediaType
      changed = true
      uploaded++
      bytes += result.bytes
    } catch {
      failed++
    }
  }

  if (typeof originalImageData === 'string' && originalImageData.startsWith('data:')) {
    let result = externalizedByDataUrl.get(originalImageData)
    if (!result) {
      try {
        result = await uploadAttachment(sessionId, originalImageData, undefined, undefined, !!options.dryRun) || undefined
        if (result) {
          uploaded++
          bytes += result.bytes
        }
      } catch {
        failed++
      }
    }
    if (result) {
      const hasPart = parts.some((candidate) => {
        const part = candidate as Partial<ChatAttachmentPart>
        return part?.attachmentKey === result?.key
      })
      if (!hasPart) {
        parts.push({
          type: 'file',
          mediaType: result.mediaType,
          url: buildChatAttachmentUrl(result.key),
          attachmentKey: result.key,
        })
        changed = true
      }
      imageData = null
    }
  }

  const serializedParts =
    originalParts || parts.length > 0
      ? JSON.stringify(parts)
      : partsInput as string | null | undefined

  return {
    parts: changed ? serializedParts : (partsInput as string | null | undefined),
    imageData: imageData !== originalImageData ? imageData : (imageDataInput as string | null | undefined),
    changed: changed || imageData !== originalImageData,
    uploaded,
    bytes,
    failed,
  }
}

async function inlineAttachmentPart(part: any): Promise<any> {
  if (!part || typeof part !== 'object' || part.type !== 'file' || typeof part.url !== 'string') {
    return part
  }
  const key = attachmentKeyFromUrl(part.url)
  if (!key) return part
  const dataUrl = await loadAttachmentAsDataUrl(key)
  return { ...part, url: dataUrl }
}

/**
 * Restore references in a chat request only where the runtime needs bytes:
 * the explicit current-turn `files` and the last user message's file parts.
 */
export async function inlineChatBodyAttachments(body: any): Promise<any> {
  if (!body || typeof body !== 'object') return body
  const next = { ...body }

  if (Array.isArray(body.files)) {
    next.files = await Promise.all(body.files.map((part: any) => inlineAttachmentPart(part)))
  }

  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages]
    for (let index = next.messages.length - 1; index >= 0; index--) {
      const message = next.messages[index]
      if (message?.role !== 'user') continue
      if (Array.isArray(message.parts)) {
        next.messages[index] = {
          ...message,
          parts: await Promise.all(message.parts.map((part: any) => inlineAttachmentPart(part))),
        }
      }
      break
    }
  }

  return next
}

export async function loadAttachmentAsDataUrl(key: string): Promise<string> {
  if (!key.startsWith(CHAT_ATTACHMENT_PREFIX)) throw new Error('Invalid chat attachment key')
  const response = await getArtifactS3Client().send(new GetObjectCommand({
    Bucket: getArtifactBucket(),
    Key: key,
  }))
  const bytes = await response.Body?.transformToByteArray()
  if (!bytes) throw new Error(`Empty chat attachment: ${key}`)
  return `data:${response.ContentType || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`
}

export async function externalizeToolOutput(
  sessionId: string,
  output: any,
  options: ExternalizeOptions = {},
): Promise<any> {
  if (!output || typeof output !== 'object') return output
  if (Array.isArray(output)) {
    return Promise.all(output.map((item) => externalizeToolOutput(sessionId, item, options)))
  }
  if (output.type === 'image' && typeof output.data === 'string' && !output.url) {
    const dataUrl = output.data.startsWith('data:')
      ? output.data
      : `data:${output.mimeType || 'image/png'};base64,${output.data}`
    try {
      const uploaded = await uploadAttachment(
        sessionId,
        dataUrl,
        output.mimeType || 'image/png',
        undefined,
        !!options.dryRun,
      )
      if (uploaded) {
        return {
          ...output,
          data: undefined,
          dataInFile: true,
          attachmentKey: uploaded.key,
          url: buildChatAttachmentUrl(uploaded.key),
        }
      }
    } catch {
      // Preserve the inline result if object storage is temporarily unavailable.
    }
    return output
  }

  const entries = await Promise.all(
    Object.entries(output).map(async ([key, value]) => [
      key,
      await externalizeToolOutput(sessionId, value, options),
    ] as const),
  )
  return Object.fromEntries(entries)
}

async function exportChatValue(value: any): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => exportChatValue(item)))
  }
  if (!value || typeof value !== 'object') return value

  const key = typeof value.url === 'string' ? attachmentKeyFromUrl(value.url) : null
  if (key && value.type === 'image') {
    const dataUrl = await loadAttachmentAsDataUrl(key)
    return {
      ...value,
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      url: undefined,
      dataInFile: undefined,
      attachmentKey: undefined,
    }
  }
  if (key) {
    return { ...value, url: await loadAttachmentAsDataUrl(key) }
  }

  const entries = await Promise.all(
    Object.entries(value).map(async ([name, child]) => [name, await exportChatValue(child)] as const),
  )
  return Object.fromEntries(entries)
}

export async function exportChatParts(partsInput: unknown): Promise<string | null | undefined> {
  const parts = parseParts(partsInput)
  if (!parts) return partsInput as string | null | undefined
  return JSON.stringify(await exportChatValue(parts))
}

export async function deleteChatAttachmentPrefix(sessionId: string): Promise<void> {
  if (!sessionId) return
  const prefix = `${CHAT_ATTACHMENT_PREFIX}${sessionId}/`
  let continuationToken: string | undefined
  do {
    const response = await getArtifactS3Client().send(new ListObjectsV2Command({
      Bucket: getArtifactBucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }))
    const objects = (response?.Contents || [])
      .map((object: any) => object?.Key && { Key: object.Key })
      .filter(Boolean)
    if (objects.length > 0) {
      await Promise.all(
        objects.map((object: { Key: string }) =>
          getArtifactS3Client().send(new DeleteObjectCommand({
            Bucket: getArtifactBucket(),
            Key: object.Key,
          })),
        ),
      )
    }
    continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)
}

export async function getChatAttachmentReadUrl(key: string): Promise<string> {
  return getArtifactPresignedReadUrl(key, { expiresIn: 300 })
}
