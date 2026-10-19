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
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getArtifactBucket, getArtifactPresignedReadUrl, getArtifactS3Client } from './s3'
import { safeTokenEqual } from './crypto-util'

export const CHAT_ATTACHMENT_PREFIX = 'artifacts/chat-attachments/'
export const CHAT_ATTACHMENT_URL_PREFIX = '/api/chat-attachments/'
/** Placeholder an exported chat part carries instead of an inlined data URL. */
export const ATTACHMENT_REF_PREFIX = 'attachment://'

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

const MARKDOWN_MEDIA_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g
const MARKDOWN_FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const INLINE_CODE_RE = /(`+)([^`\n]*?)\1/g
const URL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:(?!\/\/\/)|\/\/|#)/i
export const MAX_ASSISTANT_MEDIA_FILES = 10
export const MAX_ASSISTANT_MEDIA_BYTES = 50 * 1024 * 1024

/**
 * Hide fenced blocks and inline code from a markdown scan: an image ref a
 * message only quotes is documentation, not an attachment. `restore` puts the
 * original text back once the scan has rewritten what it found.
 */
export function maskMarkdownCode(markdown: string): { masked: string; restore: (text: string) => string } {
  const hidden: string[] = []
  const hide = (match: string) => {
    hidden.push(match)
    return `\u0000CODE${hidden.length - 1}\u0000`
  }
  const masked = markdown.replace(MARKDOWN_FENCE_RE, hide).replace(INLINE_CODE_RE, hide)
  return {
    masked,
    restore: (text) => text.replace(/\u0000CODE(\d+)\u0000/g, (_, index: string) => hidden[Number(index)] ?? ''),
  }
}


/**
 * Workspace-relative path for a markdown media target, or null when the
 * target is already a URL (http, data, blob, stored attachment).
 */
export function workspaceMediaPath(target: string): string | null {
  let value = target.trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  if (!value) return null
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      return null
    }
  } else if (URL_SCHEME_RE.test(value) || value.startsWith('/api/')) {
    return null
  }
  if (value.startsWith('/shogo-image?')) {
    try {
      value = new URL(value, 'http://shogo.local').searchParams.get('path') || ''
    } catch {
      return null
    }
  }
  value = value.replace(/\\/g, '/').replace(/^\.\//, '')
  const rooted = /\/(?:app\/)?workspace\/(.+)$/.exec(value)
  if (value.startsWith('/') && rooted) value = rooted[1]!
  value = value.replace(/^\/+/, '')
  if (!value || value.split('/').includes('..')) return null
  return value
}

/** Runtime route that serves a workspace file. */
export function workspaceDownloadPath(path: string): string {
  return `/agent/workspace/download/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`
}

export interface AssistantMediaBudget {
  /** Workspace path -> stored URL, shared across a message's text parts. */
  stored: Map<string, string | null>
  files: number
  bytes: number
}

export function newAssistantMediaBudget(): AssistantMediaBudget {
  return { stored: new Map(), files: 0, bytes: 0 }
}

/**
 * Copy workspace images and videos referenced by `![alt](path)` in an
 * assistant reply into chat-attachment storage and point the markdown at the
 * stored copies, so the reply still renders after the agent sleeps or the
 * file is removed. A ref that can't be fetched or stored is left as written.
 */
export async function externalizeAssistantTextMedia(
  sessionId: string,
  text: string,
  fetchFile: (path: string) => Promise<Response | null>,
  budget: AssistantMediaBudget = newAssistantMediaBudget(),
): Promise<string> {
  if (!text.includes('![')) return text
  const { masked, restore } = maskMarkdownCode(text)

  const paths = new Set<string>()
  for (const match of masked.matchAll(MARKDOWN_MEDIA_RE)) {
    const path = workspaceMediaPath(match[2]!)
    if (path) paths.add(path)
  }

  for (const path of paths) {
    if (budget.stored.has(path)) continue
    if (budget.files >= MAX_ASSISTANT_MEDIA_FILES) {
      budget.stored.set(path, null)
      continue
    }
    budget.stored.set(path, await storeWorkspaceMedia(sessionId, path, fetchFile, budget))
  }

  const rewritten = masked.replace(MARKDOWN_MEDIA_RE, (full, alt: string, target: string, title: string) => {
    const path = workspaceMediaPath(target)
    const url = path ? budget.stored.get(path) : null
    return url ? `![${alt}](${url}${title})` : full
  })
  return restore(rewritten)
}

async function storeWorkspaceMedia(
  sessionId: string,
  path: string,
  fetchFile: (path: string) => Promise<Response | null>,
  budget: AssistantMediaBudget,
): Promise<string | null> {
  try {
    const response = await fetchFile(path)
    if (!response || !response.ok) return null
    const mediaType = (response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    if (!mediaType.startsWith('image/') && !mediaType.startsWith('video/')) return null
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared && budget.bytes + declared > MAX_ASSISTANT_MEDIA_BYTES) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (budget.bytes + bytes.byteLength > MAX_ASSISTANT_MEDIA_BYTES) return null
    const name = path.split('/').pop()
    const key = buildChatAttachmentKey(sessionId, bytes, mediaType, name)
    await getArtifactS3Client().send(new PutObjectCommand({
      Bucket: getArtifactBucket(),
      Key: key,
      Body: bytes,
      ContentType: mediaType,
    }))
    budget.files++
    budget.bytes += bytes.byteLength
    return buildChatAttachmentUrl(key)
  } catch {
    return null
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

export interface ExportedChatAttachment {
  /** Object-store key the exporter read the bytes from. */
  key: string
  mimeType: string
  /** `data:` URL; empty when the object could not be read. */
  dataUrl: string
}

/**
 * Like {@link exportChatParts}, but attachment bytes are *returned* instead of
 * inlined, and each reference is rewritten to `attachment://<key>`.
 *
 * A workspace archive ships attachment bytes as their own entries, so inlining
 * them would put megabytes into `data/ChatMessage.json` and make the whole
 * archive unstreamable. The rewrite keeps the parts small and lets the importer
 * decide what to do with the bytes.
 */
export async function exportChatPartsWithAttachments(partsInput: unknown): Promise<{
  parts: string | null | undefined
  attachments: ExportedChatAttachment[]
}> {
  if (typeof partsInput !== 'string' || !partsInput.includes(CHAT_ATTACHMENT_URL_PREFIX)) {
    return { parts: partsInput as string | null | undefined, attachments: [] }
  }
  const parts = parseParts(partsInput)
  if (!parts) return { parts: partsInput, attachments: [] }

  const byKey = new Map<string, ExportedChatAttachment>()
  const walk = async (value: any): Promise<any> => {
    if (Array.isArray(value)) return Promise.all(value.map(walk))
    if (!value || typeof value !== 'object') return value

    const key = typeof value.url === 'string' ? attachmentKeyFromUrl(value.url) : null
    if (key) {
      if (!byKey.has(key)) {
        let dataUrl = ''
        try {
          dataUrl = await loadAttachmentAsDataUrl(key)
        } catch {
          // Unreadable object: keep the reference so the import report can say
          // which attachment is missing instead of dropping it silently.
          dataUrl = ''
        }
        const mimeType =
          (dataUrl.startsWith('data:') ? dataUrl.slice(5, dataUrl.indexOf(';')) : '') ||
          value.mimeType ||
          'application/octet-stream'
        byKey.set(key, { key, mimeType, dataUrl })
      }
      return {
        ...value,
        url: `${ATTACHMENT_REF_PREFIX}${key}`,
        data: undefined,
        dataInFile: undefined,
        attachmentKey: undefined,
      }
    }

    const entries = await Promise.all(
      Object.entries(value).map(async ([name, child]) => [name, await walk(child)] as const),
    )
    return Object.fromEntries(entries)
  }

  const rewritten = await walk(parts)
  return { parts: JSON.stringify(rewritten), attachments: [...byKey.values()] }
}

function rehomeAttachmentKey(key: string, sessionId: string): string {
  return `${CHAT_ATTACHMENT_PREFIX}${sessionId}/${key.slice(CHAT_ATTACHMENT_PREFIX.length).split('/').slice(1).join('/')}`
}

async function copyChatValueToSession(
  value: any,
  sessionId: string,
  copies: Map<string, Promise<string>>,
): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => copyChatValueToSession(item, sessionId, copies)))
  }
  if (!value || typeof value !== 'object') return value

  const key = typeof value.url === 'string' ? attachmentKeyFromUrl(value.url) : null
  if (key) {
    let copied = copies.get(key)
    if (!copied) {
      const targetKey = rehomeAttachmentKey(key, sessionId)
      copied = getArtifactS3Client()
        .send(new CopyObjectCommand({
          Bucket: getArtifactBucket(),
          CopySource: `${getArtifactBucket()}/${key}`,
          Key: targetKey,
        }))
        .then(() => targetKey)
      copies.set(key, copied)
    }
    const targetKey = await copied
    return {
      ...value,
      url: buildChatAttachmentUrl(targetKey),
      ...(value.attachmentKey ? { attachmentKey: targetKey } : {}),
    }
  }

  const entries = await Promise.all(
    Object.entries(value).map(async ([name, child]) => [
      name,
      await copyChatValueToSession(child, sessionId, copies),
    ] as const),
  )
  return Object.fromEntries(entries)
}

/**
 * Copy every attachment referenced by `parts` under `sessionId`'s prefix and
 * point the references at the copies. Sessions must own their objects because
 * deleting a session deletes its whole prefix. Pass the same `copies` map for
 * all messages in one operation so shared objects are copied once.
 */
export async function copyChatPartsToSession(
  partsInput: unknown,
  sessionId: string,
  copies: Map<string, Promise<string>> = new Map(),
): Promise<string | null | undefined> {
  if (typeof partsInput !== 'string' || !partsInput.includes(CHAT_ATTACHMENT_URL_PREFIX)) {
    return partsInput as string | null | undefined
  }
  const parts = parseParts(partsInput)
  if (!parts) return partsInput
  return JSON.stringify(await copyChatValueToSession(parts, sessionId, copies))
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
