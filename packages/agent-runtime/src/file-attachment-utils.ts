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
}

export interface ParsedAttachments {
  images: ImageContent[]
  textContext: string
}

/**
 * Parse file parts into images (for native vision) and text context
 * (for inline prompt injection). Images go directly to the model;
 * text files / PDFs are decoded and wrapped in delimiters.
 */
export function parseFileAttachments(parts: FilePart[]): ParsedAttachments {
  const fileParts = parts.filter((p) => p.type === 'file' && p.url)
  if (fileParts.length === 0) return { images: [], textContext: '' }

  const images: ImageContent[] = []
  const sections: string[] = []

  for (const fp of fileParts) {
    const mediaType = fp.mediaType || 'application/octet-stream'
    const url = fp.url!
    const label = fp.name ? `${fp.name} (${mediaType})` : mediaType

    if (!url.startsWith('data:')) continue

    const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
    if (!base64Match) continue

    if (mediaType.startsWith('image/')) {
      images.push({ type: 'image', data: base64Match[1], mimeType: mediaType })
      continue
    }

    const isTextBased =
      mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)

    try {
      const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8')
      if (isTextBased || (!decoded.includes('\0') && decoded.length > 0)) {
        sections.push(
          `[Attached File (${label})]:\n${decoded}\n[End of Attached File]`,
        )
      } else {
        sections.push(
          `[Attached File (${label})]: Binary file attached (content cannot be displayed as text).`,
        )
      }
    } catch {
      sections.push(
        `[Attached File (${label})]: Could not decode file content.`,
      )
    }
  }

  return { images, textContext: sections.join('\n\n') }
}

/** @deprecated Use parseFileAttachments instead */
export function extractFilePartsAsText(parts: FilePart[]): string {
  return parseFileAttachments(parts).textContext
}
