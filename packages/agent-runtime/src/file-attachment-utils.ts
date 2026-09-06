// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File attachment helpers — parse data-URL file parts into:
 *   1. ImageContent[] for native multi-modal model support (images)
 *   2. A text context string for non-image files (PDFs, code, etc.)
 */

import type { ImageContent } from '@mariozechner/pi-ai'

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
 * Parse file parts into images (for native vision) and text context
 * (for inline prompt injection). Images go directly to the model;
 * text files are decoded and wrapped in delimiters; everything else is
 * announced as a saved attachment so the agent can reach for the right
 * tool (e.g. unzip via shell, dedicated parsers) instead of guessing at
 * binary content.
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

export function parseFileAttachments(parts: FilePart[]): ParsedAttachments {
  const fileParts = parts.filter((p) => p.type === 'file' && p.url)
  if (fileParts.length === 0) return { images: [], textContext: '', audioParts: [] }

  const images: ImageContent[] = []
  const audioParts: FilePart[] = []
  const sections: string[] = []

  for (const fp of fileParts) {
    const mediaType = fp.mediaType || 'application/octet-stream'
    const url = fp.url!
    const label = fp.name ? `${fp.name} (${mediaType})` : mediaType
    const savedSuffix = formatSavedPathSuffix(fp.savedPath)

    if (!url.startsWith('data:')) continue

    const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
    if (!base64Match) continue

    if (mediaType.startsWith('image/')) {
      images.push({ type: 'image', data: base64Match[1], mimeType: mediaType })
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

    try {
      const decoded = _fileAttachmentSeamForTests.decodeBase64Utf8(base64Match[1])
      if (isTextBased || (!decoded.includes('\0') && decoded.length > 0)) {
        const header = `[Attached File (${label})]:${savedSuffix}`
        sections.push(`${header}\n${decoded}\n[End of Attached File]`)
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

    const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
    if (!base64Match) {
      sections.push(`[Attached Audio (${label})]: Could not decode audio data.${savedSuffix}`)
      continue
    }

    const base64 = base64Match[1]
    if (estimateDecodedBytes(base64.length) > MAX_AUDIO_BYTES) {
      const sizeMb = (estimateDecodedBytes(base64.length) / (1024 * 1024)).toFixed(1)
      sections.push(
        `[Attached Audio (${label})]: Not transcribed — file is ~${sizeMb}MB, which exceeds the 25MB Whisper upload limit.${savedSuffix}`,
      )
      continue
    }

    try {
      const buffer = Buffer.from(base64, 'base64')
      const ext = AUDIO_EXT_BY_MIME[mediaType] || '.mp3'
      const formData = new FormData()
      formData.append('file', new Blob([buffer], { type: mediaType }), fp.name || `audio${ext}`)
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
