// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File attachment helpers — parse data-URL file parts into:
 *   1. ImageContent[] for native multi-modal model support (images)
 *   2. A text context string for non-image files (PDFs, code, etc.)
 */

import type { ImageContent, Message, TextContent } from '@mariozechner/pi-ai'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { isBinaryBuffer } from '@shogo/shared-runtime'
import { enforceImageSizeLimit, MAX_IMAGE_BASE64_BYTES } from './image-size-guard'
import { userMessage } from './pi-adapter'

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/csv',
  'application/sql',
  'application/x-sh',
  'application/xhtml+xml',
  'application/ld+json',
])

const BINARY_DOCUMENT_MEDIA_TYPES = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
])

export interface FilePart {
  type: string
  mediaType?: string
  url?: string
  name?: string
  /**
   * Optional workspace-relative path where this attachment was saved by the
   * runtime (e.g. `files/report.zip`). When provided, parseFileAttachments
   * surfaces this path in the inline attachment context so the agent always
   * knows where to find the file even when its content cannot be inlined.
   */
  savedPath?: string
}

export interface ParsedAttachments {
  images: ImageContent[]
  textContext: string
  /**
   * Raw `audio/*` file parts, deferred for async transcription (see
   * `transcribeAudioParts`). Not resolved here because `parseFileAttachments`
   * is synchronous and transcription requires a network call — no model in
   * the agent-runtime's pi-ai-backed chat loop accepts native audio content
   * blocks (pi-ai's `Model.input` type only allows `"text" | "image"`), so
   * every model gets audio via a text transcript, not a native audio block.
   */
  audioParts: FilePart[]
}

function formatSavedPathSuffix(savedPath?: string): string {
  return savedPath ? ` Saved to workspace at \`${savedPath}\`.` : ''
}

/**
 * Cap on how much of a single text attachment is inlined into the prompt.
 *
 * Without it a 10 MB CSV is ~2.5M tokens in one message, which the runtime
 * then stores in the session — so every later model call carries it too. The
 * agent reads the rest with `read_file`/`exec` from the saved path.
 */
export const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024

/** Cap on inlined attachment text across one turn, so ten files can't add up. */
export const MAX_INLINE_TURN_BYTES = 256 * 1024

/** Head kept from a file that is too large to inline in full. */
export const INLINE_TRUNCATED_HEAD_BYTES = 8 * 1024

export interface ParseFileAttachmentsOptions {
  /**
   * Workspace root, needed to read a reference part's bytes from disk. Parts
   * that carry a `savedPath` but no `data:` URL (the upload-first transport)
   * are unreadable without it and are announced instead of inlined.
   */
  workspaceDir?: string
}

type PartSource =
  | { kind: 'data'; bytes: Buffer; base64: string }
  | { kind: 'file'; size: number; read: (limit: number) => Buffer }
  | { kind: 'missing' }
  | null

function resolveInside(rootDir: string, subPath: string): string | null {
  const root = resolve(rootDir)
  const resolved = resolve(root, subPath)
  if (resolved === root) return null
  if (!resolved.startsWith(root + sep)) return null
  return resolved
}

/**
 * Where a file part's bytes come from: an inline `data:` URL (legacy clients,
 * eval runners, pasted text) or a workspace file the client uploaded first.
 * `read(limit)` never reads more than `limit` bytes, so a 200 MB attachment
 * costs a bounded read rather than a whole-file buffer.
 */
function resolvePartSource(fp: FilePart, workspaceDir: string | undefined): PartSource {
  const url = fp.url
  if (url && url.startsWith('data:')) {
    const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
    if (!base64Match) return null
    const base64 = base64Match[1]
    return { kind: 'data', base64, bytes: Buffer.from(base64, 'base64') }
  }
  if (!fp.savedPath || !workspaceDir) return null
  const resolved = resolveInside(workspaceDir, fp.savedPath)
  if (!resolved) return { kind: 'missing' }
  let size = 0
  try {
    const stat = statSync(resolved)
    if (!stat.isFile()) return { kind: 'missing' }
    size = stat.size
  } catch {
    return { kind: 'missing' }
  }
  return {
    kind: 'file',
    size,
    read(limit: number): Buffer {
      const length = Math.max(0, Math.min(limit, size))
      const buffer = Buffer.alloc(length)
      const fd = openSync(resolved, 'r')
      try {
        const readBytes = readSync(fd, buffer, 0, length, 0)
        return readBytes === length ? buffer : buffer.subarray(0, readBytes)
      } finally {
        closeSync(fd)
      }
    },
  }
}

function truncationNote(totalBytes: number, savedPath?: string): string {
  const readHint = savedPath
    ? `The full file is saved at \`${savedPath}\`. Read the rest with read_file (offset/limit) or exec.`
    : 'The full file is not available to read.'
  return `[Truncated: ${totalBytes} total bytes. ${readHint}]`
}

/**
 * Parse file parts into images (for native vision) and text context
 * (for inline prompt injection). Images go directly to the model;
 * text files are decoded and wrapped in delimiters, capped per file and per
 * turn; everything else is announced as a saved attachment so the agent can
 * reach for the right tool (e.g. unzip via shell, dedicated parsers) instead
 * of guessing at binary content.
 */
/**
 * Test-only indirection seam — production code routes through the default
 * `Buffer.from(..., 'base64').toString('utf-8')` implementation. Swap
 * `decodeBase64Utf8` in a unit test to drive the otherwise unreachable
 * `catch { ... }` arm inside the base64-decode block (Buffer.from with
 * invalid base64 input does not throw under Bun/Node — it silently
 * filters — so the catch is a defensive guard without a natural trigger).
 */
export const _fileAttachmentSeamForTests: {
  decodeBase64Utf8: (b64: string) => string
} = {
  decodeBase64Utf8: (b64: string) => Buffer.from(b64, 'base64').toString('utf-8'),
}

export function parseFileAttachments(
  parts: FilePart[],
  options: ParseFileAttachmentsOptions = {},
): ParsedAttachments {
  const fileParts = parts.filter((p) => p.type === 'file' && (p.url || p.savedPath))
  if (fileParts.length === 0) return { images: [], textContext: '', audioParts: [] }

  const images: ImageContent[] = []
  const audioParts: FilePart[] = []
  const sections: string[] = []
  let turnBudget = MAX_INLINE_TURN_BYTES

  for (const fp of fileParts) {
    const mediaType = fp.mediaType || 'application/octet-stream'
    const url = fp.url || ''
    const label = fp.name ? `${fp.name} (${mediaType})` : mediaType
    const savedSuffix = formatSavedPathSuffix(fp.savedPath)
    const source = resolvePartSource(fp, options.workspaceDir)

    if (source === null) continue
    if (source.kind === 'missing') {
      sections.push(
        `[Attached File (${label})]: Not found in the workspace at \`${fp.savedPath}\` — ask the user to attach it again.`,
      )
      continue
    }

    const byteLength = source.kind === 'data' ? source.bytes.length : source.size

    if (mediaType.startsWith('image/')) {
      // Never pull a huge image into the prompt as base64; announce it and let
      // the agent look at it with a tool if it needs to.
      if (byteLength > MAX_IMAGE_BASE64_BYTES) {
        sections.push(
          `[Attached Image (${label})]: Too large to send to the model (${byteLength} bytes).${savedSuffix}`,
        )
        continue
      }
      const base64 = source.kind === 'data'
        ? source.base64
        : source.read(MAX_IMAGE_BASE64_BYTES).toString('base64')
      images.push({ type: 'image', data: base64, mimeType: mediaType })
      if (fp.savedPath) {
        sections.push(`[Attached Image (${label})]:${savedSuffix}`)
      }
      continue
    }

    if (mediaType.startsWith('audio/')) {
      // Deferred: no model in the agent-runtime chat loop accepts native
      // audio content blocks, so every audio attachment is transcribed to
      // text (see `transcribeAudioParts`) instead of being inlined here.
      audioParts.push(fp)
      continue
    }

    const isTextBased =
      mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)
    const binaryByType = BINARY_DOCUMENT_MEDIA_TYPES.has(mediaType)

    try {
      // Inline at most one file's cap and whatever is left of the turn's
      // budget; a bigger file contributes its head plus a truncation note.
      const inlineBudget = Math.min(MAX_INLINE_ATTACHMENT_BYTES, turnBudget)
      const truncated = byteLength > inlineBudget
      const limit = truncated ? Math.min(INLINE_TRUNCATED_HEAD_BYTES, byteLength) : byteLength
      const head = source.kind === 'data'
        ? source.bytes.subarray(0, limit)
        : source.read(limit)
      const decoded = source.kind === 'data' && !truncated
        ? _fileAttachmentSeamForTests.decodeBase64Utf8(source.base64)
        : head.toString('utf-8')
      const binaryByMagic = isBinaryBuffer(head)
      if (isTextBased && !binaryByType && !binaryByMagic
        || !binaryByType && !binaryByMagic && !decoded.includes('\0') && decoded.length > 0) {
        const header = `[Attached File (${label})]:${savedSuffix}`
        const body = truncated
          ? `${decoded}\n${truncationNote(byteLength, fp.savedPath)}`
          : decoded
        sections.push(`${header}\n${body}\n[End of Attached File]`)
        turnBudget = Math.max(0, turnBudget - head.length)
      } else {
        sections.push(
          `[Attached File (${label})]: Binary content (cannot be inlined as text).${savedSuffix}`,
        )
      }
    } catch {
      sections.push(
        `[Attached File (${label})]: Could not decode file content.${savedSuffix}`,
      )
    }
  }

  return { images, textContext: sections.join('\n\n'), audioParts }
}

/** @deprecated Use parseFileAttachments instead */
export function extractFilePartsAsText(parts: FilePart[]): string {
  return parseFileAttachments(parts).textContext
}

// ---------------------------------------------------------------------------
// Chat-history seeding
// ---------------------------------------------------------------------------

/**
 * Upper bound on images replayed from client-seeded history. A chat panel
 * resends the whole message array every turn, so a long attachment-heavy
 * conversation would otherwise put every image it ever held on the first
 * request after a restart.
 */
export const MAX_SEEDED_HISTORY_IMAGES = 6

/** One entry of the client-sent `allMessages` array (AI SDK part shape). */
export interface SeedHistoryMessage {
  role: string
  parts?: Array<Partial<FilePart> & { type?: string; text?: string }>
}

export interface SeedHistoryOptions {
  /** Defaults to {@link MAX_SEEDED_HISTORY_IMAGES}. */
  maxImages?: number
  /** Label used in the placeholders built for images that fail the guard. */
  label?: string
  /**
   * Workspace root, so a replayed turn's reference attachments (`savedPath`,
   * no data URL) are re-read from disk instead of being announced as a count.
   * Omit it and reference parts stay unrepresentable, which is the old
   * behaviour.
   */
  workspaceDir?: string
}

/** A prior message, pre-parsed so images can be capped across the whole run. */
type PreparedSeed =
  | { role: 'assistant'; text: string }
  | {
      role: 'user'
      text: string
      /** Image blocks that survived the size/format/decode guard. */
      images: ImageContent[]
      /** Placeholders the guard substituted for dropped images. */
      guardPlaceholders: TextContent[]
      /** Inline descriptions for non-image attachments. */
      textContext: string
      /** Attachment parts no inline representation covers. */
      unrepresentableFiles: number
    }

function isEmptyText(value: string | undefined): boolean {
  return !value || value.trim() === ''
}

/**
 * Count the file parts the seeded content gives no representation to — no
 * image block and no inline description — so the seeded history still says
 * something was attached instead of silently dropping it. A non-`data:` URL is
 * only readable when it carries a `savedPath` and the caller supplied a
 * workspace root: seeding must never fetch an arbitrary host. Audio is
 * transcribed on the live turn only, so at seed time it is just announced.
 */
function countUnrepresentableFiles(
  parts: ReadonlyArray<Partial<FilePart>>,
  hasWorkspace: boolean,
): number {
  let count = 0
  for (const part of parts) {
    if (part.type !== 'file') continue
    if (!part.url || !part.url.startsWith('data:')) {
      if (hasWorkspace && part.savedPath) {
        // Readable from disk — parseFileAttachments gave it a real section.
        if (part.mediaType?.startsWith('audio/')) count++
        continue
      }
      count++
      continue
    }
    if (!/^data:[^;]*;base64,/.test(part.url)) { count++; continue }
    // Audio is transcribed on the live turn only; nothing is left to seed.
    if (part.mediaType?.startsWith('audio/')) count++
  }
  return count
}

/**
 * Rebuild the prior conversation a client sent (`allMessages` minus the live
 * turn) into session messages.
 *
 * User turns keep their attachments: image data URLs become real `image`
 * blocks after the same guard the live path uses (`enforceImageSizeLimit`), so
 * a corrupt client-sent image becomes a placeholder instead of poisoning the
 * session. Assistant turns are text only — pi-ai's `AssistantMessage` cannot
 * carry images.
 */
export function buildSeededHistoryMessages(
  priorMessages: ReadonlyArray<SeedHistoryMessage>,
  options: SeedHistoryOptions = {},
): Message[] {
  const maxImages = Math.max(0, options.maxImages ?? MAX_SEEDED_HISTORY_IMAGES)
  const label = options.label ?? 'history'
  const prepared: PreparedSeed[] = []

  for (const msg of priorMessages) {
    const parts = msg.parts ?? []
    const text = parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')

    if (msg.role === 'assistant') {
      if (isEmptyText(text)) continue
      prepared.push({ role: 'assistant', text })
      continue
    }
    if (msg.role !== 'user') continue

    const parsed = parseFileAttachments(parts as FilePart[], {
      workspaceDir: options.workspaceDir,
    })
    const guarded = parsed.images.length > 0
      ? enforceImageSizeLimit(parsed.images, { label })
      : []
    prepared.push({
      role: 'user',
      text,
      images: guarded.filter((b): b is ImageContent => b.type === 'image'),
      guardPlaceholders: guarded.filter((b): b is TextContent => b.type === 'text'),
      textContext: parsed.textContext,
      unrepresentableFiles: countUnrepresentableFiles(parts, !!options.workspaceDir),
    })
  }

  const totalImages = prepared.reduce(
    (n, entry) => n + (entry.role === 'user' ? entry.images.length : 0),
    0,
  )
  // Drop images from the oldest end: a follow-up usually refers to the most
  // recent attachment, so the tail of the conversation is what must survive.
  let imagesToDrop = Math.max(0, totalImages - maxImages)

  const messages: Message[] = []
  for (const entry of prepared) {
    if (entry.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: entry.text }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'history',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as Message)
      continue
    }

    let images = entry.images
    let droppedByCap = 0
    if (imagesToDrop > 0 && images.length > 0) {
      droppedByCap = Math.min(imagesToDrop, images.length)
      images = images.slice(droppedByCap)
      imagesToDrop -= droppedByCap
    }

    const notes: string[] = []
    if (droppedByCap > 0) notes.push(`[${droppedByCap} image(s) were attached]`)
    if (entry.unrepresentableFiles > 0) {
      notes.push(`[${entry.unrepresentableFiles} file(s) were attached]`)
    }
    const effectiveText = [entry.text, notes.join('\n'), entry.textContext]
      .filter((s) => !isEmptyText(s))
      .join('\n\n')

    if (images.length === 0 && entry.guardPlaceholders.length === 0) {
      if (!effectiveText) continue
      // Byte-identical to the pre-image history seeding: string content.
      messages.push(userMessage(effectiveText))
      continue
    }

    const content: (TextContent | ImageContent)[] = []
    if (effectiveText) content.push({ type: 'text', text: effectiveText })
    content.push(...entry.guardPlaceholders, ...images)
    messages.push({ role: 'user', content, timestamp: Date.now() })
  }

  return messages
}

/**
 * Seed an empty chat session from the message array a client sent.
 *
 * AI SDK clients, eval runners and the desktop/web chat panels resend the
 * whole conversation on every turn; the session is the authoritative store, so
 * this is a no-op once the session already holds messages (seeding twice would
 * duplicate the history). Returns the number of messages added.
 */
export function seedEmptyChatSession(
  manager: {
    getOrCreate(id: string): { messages: ReadonlyArray<Message> }
    addMessages(id: string, ...msgs: Message[]): unknown
  },
  chatSessionId: string,
  priorMessages: ReadonlyArray<SeedHistoryMessage>,
  options: SeedHistoryOptions = {},
): number {
  const session = manager.getOrCreate(chatSessionId)
  if (session.messages.length > 0) return 0
  const seeded = buildSeededHistoryMessages(priorMessages, options)
  if (seeded.length > 0) manager.addMessages(chatSessionId, ...seeded)
  return seeded.length
}

// ---------------------------------------------------------------------------
// Audio transcription (Whisper, via the AI proxy)
// ---------------------------------------------------------------------------

/** OpenAI's documented Whisper upload cap (must match apps/api/src/routes/ai-proxy.ts). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Rough base64 -> decoded-byte-length estimate (base64 inflates by ~4/3). */
function estimateDecodedBytes(base64Length: number): number {
  return Math.floor((base64Length * 3) / 4)
}

const AUDIO_EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
}

export interface TranscribeAudioOptions {
  /** Defaults to `process.env.AI_PROXY_URL`. */
  aiProxyUrl?: string
  /** Defaults to `process.env.AI_PROXY_TOKEN`. */
  aiProxyToken?: string
  /** Workspace root, needed for an uploaded clip that only carries `savedPath`. */
  workspaceDir?: string
}

/**
 * Transcribe a batch of `audio/*` file parts via Whisper (through the AI
 * proxy's `/ai/v1/audio/transcriptions` route when configured, else directly
 * against OpenAI) and return a `textContext`-shaped announcement per clip,
 * ready to append to `ParsedAttachments.textContext`.
 *
 * Mirrors the `transcribe_audio` agent tool's request shape
 * (packages/agent-runtime/src/gateway-tools.ts) but operates on in-memory
 * data-URL parts rather than a workspace file path, since chat attachments
 * never touch disk before reaching the model.
 */
export async function transcribeAudioParts(
  parts: FilePart[],
  options: TranscribeAudioOptions = {},
): Promise<string> {
  if (parts.length === 0) return ''

  const proxyUrl = options.aiProxyUrl ?? process.env.AI_PROXY_URL
  const proxyToken = options.aiProxyToken ?? process.env.AI_PROXY_TOKEN
  const directKey = process.env.OPENAI_API_KEY
  // See the matching comment in gateway-tools.ts / transcription.service.ts:
  // AI_PROXY_URL is `${apiBase}/api/ai/v1`; strip the trailing `/v1` before
  // re-appending it so we land on `.../api/ai/v1/audio/transcriptions`.
  const apiBase = proxyUrl ? proxyUrl.replace(/\/v1$/, '') : 'https://api.openai.com'
  const apiKey = proxyToken || directKey

  const sections: string[] = []

  for (const fp of parts) {
    const mediaType = fp.mediaType || 'audio/mpeg'
    const url = fp.url || ''
    const label = fp.name ? `${fp.name} (${mediaType})` : mediaType
    const savedSuffix = formatSavedPathSuffix(fp.savedPath)

    if (!apiKey) {
      sections.push(`[Attached Audio (${label})]: Could not transcribe — no OpenAI API key configured.${savedSuffix}`)
      continue
    }

    // Bytes come from an inline data URL (legacy / web recorder) or from the
    // workspace file the client uploaded first (native recorder, any large clip).
    let buffer: Buffer
    const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
    if (base64Match) {
      const base64 = base64Match[1]
      if (estimateDecodedBytes(base64.length) > MAX_AUDIO_BYTES) {
        const sizeMb = (estimateDecodedBytes(base64.length) / (1024 * 1024)).toFixed(1)
        sections.push(
          `[Attached Audio (${label})]: Not transcribed — file is ~${sizeMb}MB, which exceeds the 25MB Whisper upload limit.${savedSuffix}`,
        )
        continue
      }
      buffer = Buffer.from(base64, 'base64')
    } else if (fp.savedPath && options.workspaceDir) {
      const source = resolvePartSource({ ...fp, url: undefined }, options.workspaceDir)
      if (!source || source.kind !== 'file') {
        sections.push(`[Attached Audio (${label})]: Could not read the uploaded clip.${savedSuffix}`)
        continue
      }
      if (source.size > MAX_AUDIO_BYTES) {
        const sizeMb = (source.size / (1024 * 1024)).toFixed(1)
        sections.push(
          `[Attached Audio (${label})]: Not transcribed — file is ~${sizeMb}MB, which exceeds the 25MB Whisper upload limit.${savedSuffix}`,
        )
        continue
      }
      buffer = source.read(source.size)
    } else {
      sections.push(`[Attached Audio (${label})]: Could not decode audio data.${savedSuffix}`)
      continue
    }

    try {
      const ext = AUDIO_EXT_BY_MIME[mediaType] || '.mp3'
      const formData = new FormData()
      formData.append('file', new Blob([new Uint8Array(buffer)], { type: mediaType }), fp.name || `audio${ext}`)
      formData.append('model', 'whisper-1')
      formData.append('response_format', 'verbose_json')

      const response = await fetch(`${apiBase}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(120_000),
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        sections.push(
          `[Attached Audio (${label})]: Transcription failed (${response.status}): ${errBody.slice(0, 300)}${savedSuffix}`,
        )
        continue
      }

      const result = (await response.json()) as { text?: string }
      const text = result.text?.trim()
      sections.push(
        text
          ? `[Attached Audio (${label}) — auto-transcribed]: ${text}${savedSuffix}`
          : `[Attached Audio (${label})]: Transcription returned no text.${savedSuffix}`,
      )
    } catch (err: any) {
      sections.push(`[Attached Audio (${label})]: Transcription failed: ${err.message}${savedSuffix}`)
    }
  }

  return sections.join('\n\n')
}
